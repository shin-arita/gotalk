import { useState, useEffect, useRef } from 'react'
import type { Language } from '../languages'
import { API_TIMEOUT_MS, ApiError, MAX_INTERPRET_AUDIO_BYTES, apiErrorCode, apiErrorFromResponse, isTooLongForTts, logApiError, messageKeyForCode, messageKeyForError } from '../api'
import { getLocalizedMessage } from '../messages'
import type { MessageKey } from '../messages'
import { DEFAULT_EXPERIMENT_CONFIG } from '../experiments'
import type { ExperimentConfig } from '../experiments'
import ExperimentPanel from './ExperimentPanel'
import type { LegacyRecording, LegacyTtsPlay, RecogOnlyDiagnostics, RecogOnlyEvent, RecogOnlyFinishReason, RecogOnlyRecording, RecogOnlyTtsPlay } from './ExperimentPanel'
import { joinRecognitionSegments } from '../recogOnlyText'
import './InterpreterPage.css'

// 切り分けの実験の legacy（docs/testing.md の「実験のスイッチ」）。PR #26 の前（07f06f0）の
// frontend/src/pages/InterpreterPage.tsx を、ほぼそのまま残したもの。URL の exp に legacy があるときだけ、
// 通訳の画面の代わりに使う。変えたのは、部品の名前、実験の設定の受け取り、実験の記録の行（「実験の記録」の
// コメントの行）、診断の表示の部品だけ。原因が分かったら、このファイルは外す
// exp に legacykeep があるときは、録音の後もマイク（stream と track）を閉じずに、次の録音で使い回す
// （3回目の実験。「legacykeep」のコメントの行）。画面が外れるときは、今までどおり閉じる
// exp に legacymute があるときは、legacykeep の動きに加えて、録音が止まったら track を無効にし（enabled = false）、
// 次の録音の開始で有効に戻す（4回目の実験。「legacymute」のコメントの行）
// exp に recogonly があるときは、getUserMedia も録音もせず、音声認識だけで録音の開始と終了を行う
// （5回目の実験。「recogonly」のコメントの行と、recogonly 専用の関数）

// 実験の記録に残す録音の数
const MAX_LEGACY_RECORDINGS = 10
// legacykeep：実験の記録に残す録音の数（10 回続けて話すので、legacy より多く残す）
const MAX_LEGACY_KEEP_RECORDINGS = 20
// legacymute：実験の記録に残す読み上げの数
const MAX_LEGACY_MUTE_TTS_PLAYS = 10
// 実験の記録の時刻（録音の開始と停止の処理の中でだけ呼ぶ）
const perfNow = () => performance.now()
// legacymute：実験の記録の track の状態（readyState/enabled/muted）
const describeTrack = (t: MediaStreamTrack) => `${t.readyState}/${t.enabled ? 'enabled' : 'disabled'}/${t.muted ? 'muted' : 'unmuted'}`
// recogonly：記録に残す発話と読み上げの数、1発話の出来事の数、1発話の自動の始め直しの上限、利用者の終了から onend を待つ時間
const MAX_RECOG_ONLY_RECORDINGS = 20
const MAX_RECOG_ONLY_TTS_PLAYS = 10
const MAX_RECOG_ONLY_EVENTS = 300
const MAX_RECOG_ONLY_AUTO_RESTARTS = 20
const RECOG_ONLY_END_TIMEOUT_MS = 2000
// recogonly：例外の name
const recogErrorName = (e: unknown) => (e instanceof Error || e instanceof DOMException ? e.name : typeof e)

type InterpreterStatus = 'idle' | 'recording' | 'processing' | 'ready' | 'speaking'

interface InterpreterPageProps {
  selectedLanguages: Language[]
  onBack: () => void
  experiment?: ExperimentConfig
}

interface HistoryEntry {
  id: string
  date: string
  time: string
  source: string
  translation: string
  backTranslation: string
  sourceLangId: string
  targetLangId: string
}

const LANG_LOCALE: Record<string, string> = {
  'ja':    'ja-JP',
  'en':    'en-US',
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-TW',
  'ko':    'ko-KR',
  'th':    'th-TH',
  'vi':    'vi-VN',
}

const TRANSLATING_MESSAGES: Record<string, string> = {
  'ja':    'ただいま翻訳中です',
  'en':    'Translating now',
  'zh-CN': '正在翻译中',
  'zh-TW': '正在翻譯中',
  'ko':    '번역 중입니다',
  'th':    'กำลังแปลอยู่',
  'vi':    'Đang dịch',
}

const PLEASE_WAIT_MESSAGES: Record<string, string> = {
  'ja':    'しばらくお待ちください',
  'en':    'Please wait a moment',
  'zh-CN': '请稍候',
  'zh-TW': '請稍候',
  'ko':    '잠시만 기다려 주세요',
  'th':    'กรุณารอสักครู่',
  'vi':    'Vui lòng chờ một chút',
}

const BACK_TRANSLATION_LABELS: Record<string, string> = {
  'ja':    '逆翻訳',
  'en':    'Back translation',
  'zh-CN': '反向翻译',
  'zh-TW': '反向翻譯',
  'ko':    '역번역',
  'th':    'คำแปลย้อนกลับ',
  'vi':    'Dịch ngược',
}

const FLAG_TAP_MESSAGES: Record<string, string> = {
  'ja':    '国旗をタップして話してください。',
  'en':    'Tap the flag to speak.',
  'zh-CN': '点击国旗开始说话。',
  'zh-TW': '點擊國旗開始說話。',
  'ko':    '국기를 탭하여 말씀해 주세요.',
  'th':    'แตะธงเพื่อพูด',
  'vi':    'Nhấn vào cờ để nói.',
}

const FLAG_FINISH_MESSAGES: Record<string, string> = {
  'ja':    '話し終わったらもう一度国旗をタップして終了してください。',
  'en':    'Tap the flag again when you are finished.',
  'zh-CN': '说完后再次点击国旗结束。',
  'zh-TW': '說完後再次點擊國旗結束。',
  'ko':    '말이 끝나면 국기를 다시 탭하여 종료하세요.',
  'th':    'เมื่อพูดเสร็จแล้ว แตะธงอีกครั้งเพื่อสิ้นสุด',
  'vi':    'Khi nói xong, nhấn vào cờ một lần nữa để kết thúc.',
}

function getSupportedMimeType(): string {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  return types.find(t => MediaRecorder.isTypeSupported(t)) ?? ''
}

interface SpeechRecognitionEvent {
  readonly results: { readonly length: number; readonly [i: number]: { readonly [j: number]: { readonly transcript: string } } }
}

interface SpeechRecognitionErrorEvent {
  readonly error: string
}

interface SpeechRecognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  // recogonly：記録だけに使う出来事（ブラウザの onstart は使わない。RecogOnlyEvent の start は「start() を呼んだ」の意味）
  onaudiostart: (() => void) | null
  onsoundstart: (() => void) | null
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
  onsoundend: (() => void) | null
  onaudioend: (() => void) | null
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

type SpeechRecognitionCtor = new () => SpeechRecognition

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as Window & { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

// recogonly：発話ごとの状態（ref の中身。React の state にはしない。音声認識の部品を作れたときだけ作る）
interface RecogOnlyUtterance {
  recognition: SpeechRecognition       // この発話の部品（遅れて来た出来事の照合に使う）。null にはしない
  lang: Language
  phase: 'listening' | 'stopping' | 'finished'
  committedText: string                // 前の認識（始め直す前）までの文字
  sessionText: string                  // 今回の認識の event.results の全部（確定と途中）をつないだ文字
  lastResultAt: number | null          // 今回の認識（直前の start() から）で最後に result が来た時刻。start() を呼ぶたびに null に戻す
  autoRestarts: number
  endTimer: ReturnType<typeof setTimeout> | null
  record: RecogOnlyRecording           // 記録（記録の配列にも同じものを入れる。先に作ったもの）
}

// recogonly：出来事を記録する（300 件に達していたら足さずに eventsDropped を数える）
function pushRecogEvent(record: RecogOnlyRecording, event: Omit<RecogOnlyEvent, 'at'>) {
  if (record.events.length >= MAX_RECOG_ONLY_EVENTS) { record.eventsDropped++; return }
  record.events.push({ ...event, at: Math.round(perfNow() - record.utteranceStartedAt) })
}

// recogonly：callInterpretApi の例外を、診断の interpretResult の値にする
function recogInterpretError(e: unknown): string {
  if (e instanceof ApiError) return e.reason ?? (e.status !== null ? `status_${e.status}` : 'status_none')
  if (e instanceof DOMException && e.name === 'AbortError') return 'frontend_timeout'
  return e instanceof Error ? `exception_${e.name}` : `exception_${typeof e}`
}

export default function LegacyInterpreterPage({ selectedLanguages, onBack, experiment = DEFAULT_EXPERIMENT_CONFIG }: InterpreterPageProps) {
  const [status, setStatus] = useState<InterpreterStatus>('idle')
  const [recordingFlagIndex, setRecordingFlagIndex] = useState<0 | 1 | null>(null)
  const [recognizedText, setRecognizedText] = useState('')
  const [liveTranslatedText, setLiveTranslatedText] = useState('')
  const [translatedText, setTranslatedText] = useState('')
  const [ttsText, setTtsText] = useState('')
  const [backTranslation, setBackTranslation] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [processingMsgIdx, setProcessingMsgIdx] = useState(0)
  const [processingLangs, setProcessingLangs] = useState<[string, string] | null>(null)

  const backTranslationLabel = selectedLanguages.length === 2
    ? `${BACK_TRANSLATION_LABELS[selectedLanguages[0].id] ?? '逆翻訳'} / ${BACK_TRANSLATION_LABELS[selectedLanguages[1].id] ?? '逆翻訳'}`
    : '逆翻訳'

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const userStoppedRef = useRef(false)
  const isInterpretingRef = useRef(false)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const recordingLangRef = useRef<Language | null>(null)
  const speechRecognitionRef = useRef<SpeechRecognition | null>(null)
  const hasLiveTranscriptRef = useRef(false)
  const recognizedTextRef = useRef('')
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const rippleRefs = useRef<(HTMLDivElement | null)[]>([null, null, null])
  // 実験の記録（URL に exp があるときだけ書く）
  const legacyRecordingsRef = useRef<LegacyRecording[]>([])
  const legacyRecordingRef = useRef<LegacyRecording | null>(null)
  // legacykeep：画面を開いてから getUserMedia を呼んだ回数
  const getUserMediaCallsRef = useRef(0)
  // legacykeep：getUserMedia を待っている間（待つ間の2回目の操作では何もしない）
  const keepStartingRef = useRef(false)
  // legacykeep：画面が外れた（getUserMedia が解けた後に、録音を始めずに track を止める）
  const keepUnmountedRef = useRef(false)
  // legacymute：画面を開いてから録音の記録が成立した回数と、読み上げの記録
  const muteRecordingCountRef = useRef(0)
  const muteTtsPlaysRef = useRef<LegacyTtsPlay[]>([])
  // recogonly：今の発話（ないときは null）、画面を開いてからの発話の数、画面全体の記録
  const recogUtteranceRef = useRef<RecogOnlyUtterance | null>(null)
  const recogRecordingCountRef = useRef(0)
  const recogDiagRef = useRef<RecogOnlyDiagnostics>({ recordings: [], ttsPlays: [], recognitionStarts: { gesture: 0, restart: 0 } })

  useEffect(() => {
    if (!isEditing || !editRef.current) return
    const el = editRef.current
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [isEditing])

  const addHistoryEntry = (source: string, translation: string, bt: string, srcId: string, tgtId: string) => {
    const now = new Date()
    const locale = LANG_LOCALE[srcId] ?? 'ja-JP'
    setHistory(prev => [{
      id: String(Date.now()),
      date: now.toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
      time: now.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }),
      source,
      translation,
      backTranslation: bt,
      sourceLangId: srcId,
      targetLangId: tgtId,
    }, ...prev])
  }

  // 利用者向けの文言を、選んだ2つの言語で表示する（docs/ui.md）
  const showMessage = (messageKey: MessageKey) => {
    setErrorMessage(getLocalizedMessage(messageKey, selectedLanguages[0]?.id, selectedLanguages[1]?.id))
  }

  const handleLangMismatch = () => {
    showMessage('language_unclear')
    setTranslatedText('')
    setBackTranslation('')
    setStatus('idle')
  }

  // recogRecord は recogonly の診断の記録先（recogonly でない呼び出しでは渡さない）
  const callInterpretApi = async (audioBlob: Blob, recogRecord?: RecogOnlyRecording) => {
    if (isInterpretingRef.current) {
      if (recogRecord) recogRecord.interpretResult = 'skipped_busy' // recogonly
      return
    }
    isInterpretingRef.current = true
    setStatus('processing')
    setErrorMessage('')

    const mimeType = audioBlob.type || 'audio/webm'
    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm'

    const speakerLang = recordingLangRef.current ?? selectedLanguages[0]
    const otherLang = speakerLang.id === selectedLanguages[0].id ? selectedLanguages[1] : selectedLanguages[0]
    setProcessingLangs([speakerLang.id, otherLang.id])

    const formData = new FormData()
    formData.append('audio', audioBlob, `recording.${ext}`)
    formData.append('myLanguage', JSON.stringify({ id: speakerLang.id, label: speakerLang.label }))
    formData.append('theirLanguage', JSON.stringify({ id: otherLang.id, label: otherLang.label }))
    formData.append('speaker', speakerLang.id)
    // Web Speech API のテキストがあれば送信 → バックエンドが Whisper 再文字起こしをスキップして翻訳に使用
    if (hasLiveTranscriptRef.current && recognizedTextRef.current) {
      formData.append('transcript', recognizedTextRef.current)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS.interpret)
    try {
      // 明らかに大きい録音は送らない（nginx の 413 になるため。MAX_INTERPRET_AUDIO_BYTES を参照）
      if (audioBlob.size > MAX_INTERPRET_AUDIO_BYTES) throw new ApiError('recording_too_long', '/api/interpret', null, 'recording_too_large_before_send')

      // legacykeep：音声認識の文字を付けて送ったか（Backend に送る直前に記録する）
      const keep = legacyRecordingRef.current?.keepStream
      if (keep) keep.transcriptSent = formData.has('transcript')
      // recogonly：音声認識の文字を付けて送ったか
      if (recogRecord) recogRecord.transcriptSent = formData.has('transcript')

      const res = await fetch('/api/interpret', { method: 'POST', body: formData, signal: controller.signal })

      // 413 は、Backend の JSON（input_too_large）でも nginx の HTML でも、同じ文言にする
      if (res.status === 413) throw new ApiError('recording_too_long', '/api/interpret', 413, 'request_too_large')

      if (res.status === 422) {
        const data = await res.json()
        if (data.error === 'language_mismatch') {
          if (recogRecord) recogRecord.interpretResult = 'language_mismatch' // recogonly
          handleLangMismatch()
          return
        }
      }
      if (!res.ok) throw await apiErrorFromResponse('/api/interpret', res)

      const data = await res.json()
      if (!hasLiveTranscriptRef.current) { recognizedTextRef.current = data.text; setRecognizedText(data.text) }
      hasLiveTranscriptRef.current = false
      setTranslatedText(data.translatedText)
      setTtsText(data.ttsText ?? data.translatedText)
      setBackTranslation(data.backTranslation)
      setStatus('ready')
      addHistoryEntry(data.text, data.translatedText, data.backTranslation, data.sourceLanguage, data.targetLanguage)
      if (recogRecord) recogRecord.interpretResult = 'ok' // recogonly
    } catch (e) {
      if (recogRecord) recogRecord.interpretResult = recogInterpretError(e) // recogonly
      showMessage(messageKeyForError('/api/interpret', e))
      setStatus('idle')
    } finally {
      clearTimeout(timer)
      isInterpretingRef.current = false
    }
  }

  // テキスト編集後の再翻訳にのみ使用
  const callTranslateApi = async (text: string) => {
    setStatus('processing')
    setErrorMessage('')
    const srcLang = recordingLangRef.current ?? selectedLanguages[0]
    const tgtLang = srcLang.id === selectedLanguages[0].id ? selectedLanguages[1] : selectedLanguages[0]
    setProcessingLangs([srcLang.id, tgtLang.id])
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS.translate)
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, languages: selectedLanguages.map(l => ({ id: l.id, label: l.label })) }),
        signal: controller.signal,
      })
      if (res.status === 422) {
        const data = await res.json()
        if (data.error === 'language_mismatch') { handleLangMismatch(); return }
      }
      if (!res.ok) throw await apiErrorFromResponse('/api/translate', res)
      const data = await res.json()
      setTranslatedText(data.translatedText)
      setTtsText(data.ttsText ?? data.translatedText)
      setBackTranslation(data.backTranslation)
      setStatus('ready')
      addHistoryEntry(text, data.translatedText, data.backTranslation, data.sourceLanguage, data.targetLanguage)
    } catch (e) {
      showMessage(messageKeyForError('/api/translate', e))
      setStatus('idle')
    } finally {
      clearTimeout(timer)
    }
  }

  // 録音中のリアルタイム翻訳（800ms デバウンス）。テキストや画面の状態が変わったら、送信中の fetch も abort する
  useEffect(() => {
    if (status !== 'recording' || !recognizedText) return
    const controller = new AbortController()
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(async () => {
      timeoutTimer = setTimeout(() => controller.abort(), API_TIMEOUT_MS.translate)
      try {
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: recognizedText, languages: selectedLanguages.map(l => ({ id: l.id, label: l.label })) }),
          signal: controller.signal,
        })
        if (!res.ok) return
        const data = await res.json()
        if (data.translatedText && data.sourceLanguage !== 'unknown') setLiveTranslatedText(data.translatedText)
      } catch { /* AbortError やネットワークエラーは無視 */ } finally {
        clearTimeout(timeoutTimer)
      }
    }, 800)
    return () => { clearTimeout(timer); clearTimeout(timeoutTimer); controller.abort() }
  }, [recognizedText, status, selectedLanguages])

  useEffect(() => {
    if (status !== 'processing') return
    const id = setInterval(() => setProcessingMsgIdx(i => (i + 1) % 2), 1200)
    return () => { clearInterval(id); setProcessingMsgIdx(0) }
  }, [status])

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
      streamRef.current?.getTracks().forEach(t => t.stop())
      audioRef.current?.pause()
      speechRecognitionRef.current?.stop()
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current)
      audioContextRef.current?.close()
    }
  }, [])

  // legacykeep：画面が外れたことを残す（getUserMedia を待つ間に外れたときに使う）。
  // StrictMode の開発中の付け直し（片付けの後にもう一度付ける）で、外れたままにしないよう、付けるときに戻す
  useEffect(() => {
    if (!experiment.legacyKeep) return
    keepUnmountedRef.current = false
    return () => { keepUnmountedRef.current = true }
  }, [experiment.legacyKeep])

  const startRecording = async (lang: Language, flagIndex: 0 | 1) => {
    const mimeType = getSupportedMimeType()
    // legacymute：この呼び出しで作った MediaRecorder と AudioContext（開始の途中で失敗したときに片付ける）
    let muteRecorder: MediaRecorder | null = null
    let muteAudioCtx: AudioContext | null = null
    try {
      // legacykeep：持っている stream に track が1つ以上あり、どれも ended でなければ、getUserMedia を呼ばずに
      // その stream を使う。持っていないとき、track がないとき、ended の track があるときは、古い track を
      // すべて stop() してから getUserMedia を呼ぶ。track の状態は legacykeep のときだけ読む
      // （legacy は track の状態を読まない）。muted と enabled は記録だけで、判定には使わない
      let keepTrackStates: string[] = []
      // legacymute：有効に戻した直後（getUserMedia を呼んだときは新しい）track の状態
      let muteTrackStatesAfterEnable: string[] = []
      let streamReused = false
      let stream: MediaStream
      if (experiment.legacyKeep) {
        if (keepStartingRef.current) return
        const held = streamRef.current
        const heldTracks = held?.getTracks() ?? []
        const readyStates = heldTracks.map(t => t.readyState)
        keepTrackStates = heldTracks.map((t, i) => `${readyStates[i]}/${t.enabled ? 'enabled' : 'disabled'}/${t.muted ? 'muted' : 'unmuted'}`)
        if (held && heldTracks.length > 0 && !readyStates.includes('ended')) {
          stream = held
          streamReused = true
          // legacymute：MediaRecorder を作る前に、track を有効に戻す（await は挟まない）
          if (experiment.legacyMute) {
            heldTracks.forEach(t => { t.enabled = true })
            muteTrackStatesAfterEnable = heldTracks.map(describeTrack)
          }
        } else {
          heldTracks.forEach(t => t.stop())
          streamRef.current = null
          keepStartingRef.current = true
          getUserMediaCallsRef.current++
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          } finally {
            keepStartingRef.current = false
          }
          // 待つ間に画面が外れたときは、録音を始めずに閉じる
          if (keepUnmountedRef.current) {
            stream.getTracks().forEach(t => t.stop())
            return
          }
          // legacymute：新しい track は有効のまま
          if (experiment.legacyMute) muteTrackStatesAfterEnable = stream.getTracks().map(describeTrack)
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      }
      streamRef.current = stream
      audioChunksRef.current = []
      userStoppedRef.current = false
      isInterpretingRef.current = false
      hasLiveTranscriptRef.current = false
      recordingLangRef.current = lang

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      if (experiment.legacyMute) muteRecorder = recorder
      // legacymute：ほかの録音の MediaRecorder が今の録音になった（開始の途中で失敗して止めた録音の、遅れて来た出来事）
      const replacedByOther = () => experiment.legacyMute && mediaRecorderRef.current !== null && mediaRecorderRef.current !== recorder
      // 実験の記録
      const rec: LegacyRecording | null = experiment.enabled ? { startCalledAt: null, stopCalledAt: null, dataSizes: [], blobSize: null, blobType: null } : null
      if (rec && experiment.legacyKeep) {
        rec.keepStream = {
          streamReused, getUserMediaCalls: getUserMediaCallsRef.current, trackStates: keepTrackStates, rmsMax: 0, rmsNonZeroSamples: 0, rmsSamples: 0,
          audioContextState: null, audioContextFirstTickState: null, audioContextError: null, transcriptSent: null,
        }
        // legacymute：録音の番号と、track の有効と無効の記録
        if (experiment.legacyMute) {
          rec.keepStream.recordingNo = ++muteRecordingCountRef.current
          rec.keepStream.trackStatesAfterEnable = muteTrackStatesAfterEnable
          rec.keepStream.trackStatesAfterDisable = []
        }
      }
      const maxRecordings = experiment.legacyKeep ? MAX_LEGACY_KEEP_RECORDINGS : MAX_LEGACY_RECORDINGS
      if (rec) { legacyRecordingsRef.current.push(rec); if (legacyRecordingsRef.current.length > maxRecordings) legacyRecordingsRef.current.shift() }
      legacyRecordingRef.current = rec
      recorder.ondataavailable = (e) => {
        if (rec) rec.dataSizes.push(e.data.size) // 実験の記録
        if (replacedByOther()) return
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        if (replacedByOther()) return
        // legacykeep：track を止めず、stream も手放さない（画面が外れるときに止める）
        if (!experiment.legacyKeep) {
          stream.getTracks().forEach(t => t.stop())
          streamRef.current = null
        }
        // legacymute：MediaRecorder が最後のデータを出し終わった後に、track を無効にする（利用者の停止でないときも）。
        // stop() はせず、stream も手放さない
        if (experiment.legacyMute) {
          stream.getTracks().forEach(t => { t.enabled = false })
          if (rec?.keepStream) rec.keepStream.trackStatesAfterDisable = stream.getTracks().map(describeTrack)
        }
        if (!userStoppedRef.current) return
        const blob = new Blob(audioChunksRef.current, { type: mimeType || 'audio/webm' })
        if (rec) { rec.blobSize = blob.size; rec.blobType = blob.type } // 実験の記録
        callInterpretApi(blob)
      }

      mediaRecorderRef.current = recorder
      if (rec) rec.startCalledAt = perfNow() // 実験の記録
      recorder.start()
      setRecordingFlagIndex(flagIndex)
      setStatus('recording')

      // legacykeep：RMS と AudioContext の状態の記録の先（legacy のときは undefined）
      const keep = rec?.keepStream
      try {
        const audioCtx = new AudioContext()
        if (experiment.legacyMute) muteAudioCtx = audioCtx
        if (keep) keep.audioContextState = audioCtx.state
        const source = audioCtx.createMediaStreamSource(stream)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        audioContextRef.current = audioCtx
        analyserRef.current = analyser

        const timeData = new Uint8Array(analyser.fftSize)
        let startTime: number | null = null
        const DURATION = 1500
        const COUNT = 3
        let keepFirstTick = true

        const tick = (now: number) => {
          if (startTime === null) startTime = now
          if (keep && keepFirstTick) { keepFirstTick = false; keep.audioContextFirstTickState = audioCtx.state }
          analyser.getByteTimeDomainData(timeData)
          let sum = 0
          for (let j = 0; j < timeData.length; j++) {
            const v = (timeData[j] - 128) / 128
            sum += v * v
          }
          const rms = Math.sqrt(sum / timeData.length)
          const amplitude = Math.min(1, rms * 8)
          // legacykeep：RMS の記録
          if (keep) {
            keep.rmsSamples++
            if (rms > 0) keep.rmsNonZeroSamples++
            if (rms > keep.rmsMax) keep.rmsMax = rms
          }
          const elapsed = now - startTime
          rippleRefs.current.forEach((el, ri) => {
            if (!el) return
            const phase = ((elapsed / DURATION) + ri / COUNT) % 1
            el.style.transform = `scale(${phase})`
            el.style.opacity = String((1 - phase) * amplitude * 0.75)
          })
          rafIdRef.current = requestAnimationFrame(tick)
        }
        rafIdRef.current = requestAnimationFrame(tick)
      } catch (e) {
        /* AudioContext 非対応環境では波紋なし */
        if (keep) keep.audioContextError = e instanceof Error || e instanceof DOMException ? e.name : typeof e
      }

      const RecognitionCtor = getSpeechRecognitionCtor()
      if (RecognitionCtor) {
        const recognition = new RecognitionCtor()
        recognition.lang = lang.speechCode
        recognition.interimResults = true
        recognition.continuous = true
        recognition.onresult = (event) => {
          let transcript = ''
          for (let i = 0; i < event.results.length; i++) {
            transcript += event.results[i][0].transcript
          }
          hasLiveTranscriptRef.current = true
          recognizedTextRef.current = transcript
          setRecognizedText(transcript)
        }
        recognition.onerror = () => {}
        recognition.onend = () => {
          if (mediaRecorderRef.current?.state === 'recording') {
            try { recognition.start() } catch { /* ignore */ }
          }
        }
        try {
          recognition.start()
          speechRecognitionRef.current = recognition
        } catch { /* SpeechRecognition unavailable, Whisper handles final result */ }
      }
    } catch (e) {
      console.warn('[GoTalk] microphone error', { reason: e instanceof Error ? e.name : typeof e })
      // legacymute：開始の途中で失敗したときは、この呼び出しで始めた MediaRecorder を止め（翻訳には送らない）、
      // 波紋と AudioContext を片付け、有効に戻した track を無効に戻す
      if (experiment.legacyMute) {
        if (muteRecorder?.state === 'recording') {
          userStoppedRef.current = false
          if (mediaRecorderRef.current === muteRecorder) mediaRecorderRef.current = null
          muteRecorder.stop()
        }
        if (muteAudioCtx && audioContextRef.current === muteAudioCtx) {
          if (rafIdRef.current !== null) {
            cancelAnimationFrame(rafIdRef.current)
            rafIdRef.current = null
          }
          audioContextRef.current = null
          analyserRef.current = null
        }
        // この呼び出しで作った AudioContext は、audioContextRef に入れる前の例外（内側の catch で受けたもの）でも閉じる
        if (muteAudioCtx && muteAudioCtx.state !== 'closed') muteAudioCtx.close()
        rippleRefs.current.forEach(el => {
          if (el) { el.style.transform = 'scale(0)'; el.style.opacity = '0' }
        })
        streamRef.current?.getTracks().forEach(t => { t.enabled = false })
      }
      showMessage('microphone_denied')
      setStatus('idle')
      setRecordingFlagIndex(null)
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state !== 'recording') return
    userStoppedRef.current = true
    speechRecognitionRef.current?.stop()
    speechRecognitionRef.current = null
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    rippleRefs.current.forEach(el => {
      if (el) { el.style.transform = 'scale(0)'; el.style.opacity = '0' }
    })
    audioContextRef.current?.close()
    audioContextRef.current = null
    analyserRef.current = null
    setRecordingFlagIndex(null)
    setStatus('processing')
    if (legacyRecordingRef.current) legacyRecordingRef.current.stopCalledAt = perfNow() // 実験の記録
    mediaRecorderRef.current.stop()
  }

  // recogonly：終了は、すべてここを通す（最初に呼ばれた1回だけが効く）
  const finishUtterance = (u: RecogOnlyUtterance, reason: RecogOnlyFinishReason) => {
    if (u.phase === 'finished') return
    // 1. 完了を確定し、時間切れの timer を解除する
    u.phase = 'finished'
    if (u.endTimer !== null) { clearTimeout(u.endTimer); u.endTimer = null }
    // 2. 理由と時刻を記録する
    const { record, recognition } = u
    record.finishReason = reason
    record.finishedAt = perfNow()
    // 3. 国旗の録音中の表示を戻す（unmount は画面が消えるので不要）
    if (reason !== 'unmount') setRecordingFlagIndex(null)
    // 4. 理由ごとの扱い（abort() と出来事 abort の記録は、ここでだけ行う）
    const abortRecognition = () => {
      pushRecogEvent(record, { type: 'abort' })
      try { recognition.abort() } catch { /* 無視 */ }
    }
    switch (reason) {
      case 'user-stop':
      case 'restart-limit':
      case 'restart-start-error':
        interpretUtterance(u)
        break
      case 'end-timeout':
        // 翻訳を始めた後に abort() を呼ぶ
        interpretUtterance(u)
        abortRecognition()
        break
      case 'not-allowed':
      case 'service-not-allowed':
        abortRecognition()
        showMessage('microphone_denied')
        setStatus('idle')
        break
      case 'unmount':
        abortRecognition()
        break
      case 'start-error':
        showMessage('recording_start_failed')
        setStatus('idle')
        break
      case 'ctor-missing':
        // 部品がないときは finishUtterance を通さない（startRecogOnly で記録に直接書く）
        break
    }
    // 5. 今の発話を手放す
    if (recogUtteranceRef.current === u) recogUtteranceRef.current = null
  }

  // recogonly：interpret の扱い（callInterpretApi はここでだけ呼ぶ。await しない）
  const interpretUtterance = (u: RecogOnlyUtterance) => {
    const finalText = joinRecognitionSegments(u.lang.id, u.committedText, u.sessionText).trim()
    u.record.finalTextLength = Array.from(finalText).length
    if (finalText === '') {
      u.record.interpretResult = 'empty'
      showMessage('recording_failed')
      setStatus('idle')
      return
    }
    recognizedTextRef.current = finalText
    hasLiveTranscriptRef.current = true
    callInterpretApi(new Blob([], { type: 'audio/webm' }), u.record)
  }

  // recogonly：録音の開始（国旗の1回目のタップ）。getUserMedia、MediaRecorder、AudioContext は使わない。
  // 利用者の操作の中で start() を呼ぶため、途中に await を挟まない
  const startRecogOnly = (lang: Language, flagIndex: 0 | 1) => {
    const diag = recogDiagRef.current
    const record: RecogOnlyRecording = {
      recordingNo: ++recogRecordingCountRef.current,
      lang: lang.id,
      recognitionCtorMissing: false,
      utteranceStartedAt: perfNow(),
      startCalledAt: null,
      stopCalledAt: null,
      finishedAt: null,
      startError: null,
      stopError: null,
      events: [],
      eventsDropped: 0,
      autoRestarts: 0,
      restartErrors: [],
      restartLimitReached: false,
      silenceBeforeAutoEndMs: [],
      stopToEndMs: null,
      endTimeoutFired: false,
      finishReason: null,
      finalTextLength: null,
      segments: 0,
      transcriptSent: false,
      interpretResult: null,
    }
    diag.recordings.push(record)
    if (diag.recordings.length > MAX_RECOG_ONLY_RECORDINGS) diag.recordings.shift()

    const RecognitionCtor = getSpeechRecognitionCtor()
    if (!RecognitionCtor) {
      record.recognitionCtorMissing = true
      record.finishReason = 'ctor-missing'
      record.finishedAt = perfNow()
      showMessage('recording_start_failed')
      setRecordingFlagIndex(null)
      setStatus('idle')
      return
    }

    const recognition = new RecognitionCtor()
    recognition.lang = lang.speechCode
    recognition.continuous = true
    recognition.interimResults = true
    const u: RecogOnlyUtterance = {
      recognition, lang, phase: 'listening', committedText: '', sessionText: '', lastResultAt: null, autoRestarts: 0, endTimer: null, record,
    }
    // 今の発話の部品の出来事か（前の発話の部品の出来事と、終了の後の出来事は、記録だけにする）
    const isActive = () => recogUtteranceRef.current?.recognition === recognition && u.phase !== 'finished'

    recognition.onaudiostart = () => pushRecogEvent(record, { type: 'audiostart' })
    recognition.onsoundstart = () => pushRecogEvent(record, { type: 'soundstart' })
    recognition.onspeechstart = () => pushRecogEvent(record, { type: 'speechstart' })
    recognition.onspeechend = () => pushRecogEvent(record, { type: 'speechend' })
    recognition.onsoundend = () => pushRecogEvent(record, { type: 'soundend' })
    recognition.onaudioend = () => pushRecogEvent(record, { type: 'audioend' })
    recognition.onresult = (event) => {
      pushRecogEvent(record, { type: 'result' })
      if (!isActive()) return
      let transcript = ''
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript
      }
      u.sessionText = transcript
      const text = joinRecognitionSegments(lang.id, u.committedText, u.sessionText)
      recognizedTextRef.current = text
      setRecognizedText(text)
      if (u.lastResultAt === null) record.segments++
      u.lastResultAt = perfNow()
    }
    recognition.onerror = (event) => {
      pushRecogEvent(record, { type: 'error', error: event.error })
      if (!isActive()) return
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') finishUtterance(u, event.error)
    }
    recognition.onend = () => {
      pushRecogEvent(record, { type: 'end', phase: u.phase })
      if (!isActive()) return
      if (u.phase === 'stopping') {
        record.stopToEndMs = record.stopCalledAt === null ? null : perfNow() - record.stopCalledAt
        finishUtterance(u, 'user-stop')
        return
      }
      // 自動の終わり（利用者がまだ終了していない）：途中の文字も含めて確定し、同じ部品の start() を呼び直す
      record.silenceBeforeAutoEndMs.push(u.lastResultAt === null ? null : perfNow() - u.lastResultAt)
      u.committedText = joinRecognitionSegments(lang.id, u.committedText, u.sessionText)
      u.sessionText = ''
      if (u.autoRestarts >= MAX_RECOG_ONLY_AUTO_RESTARTS) {
        record.restartLimitReached = true
        finishUtterance(u, 'restart-limit')
        return
      }
      u.autoRestarts++
      record.autoRestarts++
      diag.recognitionStarts.restart++
      u.lastResultAt = null
      pushRecogEvent(record, { type: 'start', by: 'restart' })
      try {
        recognition.start()
      } catch (e) {
        record.restartErrors.push(recogErrorName(e))
        finishUtterance(u, 'restart-start-error')
      }
    }

    // 今の startRecording と同じく、録音の開始の状態を整える（callInterpretApi が speaker と翻訳の向きを recordingLangRef から決める）
    recordingLangRef.current = lang
    hasLiveTranscriptRef.current = false
    isInterpretingRef.current = false
    recogUtteranceRef.current = u
    setRecordingFlagIndex(flagIndex)
    setStatus('recording')
    record.startCalledAt = perfNow()
    diag.recognitionStarts.gesture++
    pushRecogEvent(record, { type: 'start', by: 'gesture' })
    try {
      recognition.start()
    } catch (e) {
      record.startError = recogErrorName(e)
      finishUtterance(u, 'start-error')
    }
  }

  // recogonly：利用者の終了（国旗の2回目のタップ）。listening のときだけ受け付ける
  const stopRecogOnly = () => {
    const u = recogUtteranceRef.current
    if (!u || u.phase !== 'listening') return
    u.phase = 'stopping'
    setStatus('processing')
    const { record, recognition } = u
    record.stopCalledAt = perfNow()
    pushRecogEvent(record, { type: 'stop' })
    try {
      recognition.stop()
    } catch (e) {
      // 例外が出ても、そのまま onend と時間切れを待つ
      record.stopError = recogErrorName(e)
    }
    u.endTimer = setTimeout(() => {
      record.endTimeoutFired = true
      finishUtterance(u, 'end-timeout')
    }, RECOG_ONLY_END_TIMEOUT_MS)
  }

  // recogonly：画面が外れるとき（useEffect の片付け）は、今の発話があれば unmount で終える。
  // finishUtterance は描画ごとに作り直すので、最新のものを ref に入れて片付けで使う
  const finishUtteranceRef = useRef<((u: RecogOnlyUtterance, reason: RecogOnlyFinishReason) => void) | null>(null)
  useEffect(() => { finishUtteranceRef.current = finishUtterance })
  useEffect(() => {
    if (!experiment.recogOnly) return
    return () => {
      const u = recogUtteranceRef.current
      if (u) finishUtteranceRef.current?.(u, 'unmount')
    }
  }, [experiment.recogOnly])

  const handleFlagTap = (flagIndex: 0 | 1) => {
    if (status === 'recording') {
      if (recordingFlagIndex === flagIndex) {
        // recogonly：MediaRecorder を使わないので、recogonly 専用の終了の関数を呼ぶ
        if (experiment.recogOnly) stopRecogOnly()
        else stopRecording()
      }
      return
    }
    if (status !== 'idle' && status !== 'ready') return
    recognizedTextRef.current = ''
    setRecognizedText('')
    setLiveTranslatedText('')
    setTranslatedText('')
    setTtsText('')
    setBackTranslation('')
    setErrorMessage('')
    // recogonly：recogonly 専用の開始の関数を呼ぶ
    if (experiment.recogOnly) startRecogOnly(selectedLanguages[flagIndex], flagIndex)
    else startRecording(selectedLanguages[flagIndex], flagIndex)
  }

  const handleSpeak = async () => {
    setErrorMessage('')
    // 上限を超える翻訳の結果は読み上げない（翻訳の結果の表示はそのまま）
    if (isTooLongForTts(ttsText)) {
      showMessage('tts_too_long')
      return
    }
    setStatus('speaking')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS.tts)
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ttsText }),
        signal: controller.signal,
      })
      if (!res.ok) {
        // 利用者に知らせるべきエラー（混み合っている、など）だけを表示する。
        // input_too_large は、Frontend と Backend の文字数の判定がずれた場合などへの備え
        const code = await apiErrorCode(res)
        const messageKey = code === 'input_too_large' ? 'tts_too_long' : messageKeyForCode(code)
        throw new ApiError(messageKey, '/api/tts', res.status, code)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio
      const cleanup = () => {
        URL.revokeObjectURL(url)
        audioRef.current = null
        setStatus('ready')
      }
      audio.onended = cleanup
      audio.onerror = cleanup
      if (experiment.recogOnly) {
        // recogonly：読み上げの記録（play() を呼ぶ直前に作る。legacymute と同じ場所で記録する）
        const plays = recogDiagRef.current.ttsPlays
        const play: RecogOnlyTtsPlay = {
          afterRecordingNo: recogRecordingCountRef.current > 0 ? recogRecordingCountRef.current : null,
          playCalledAt: perfNow(),
          playResult: null,
          ended: false,
          error: false,
        }
        plays.push(play)
        if (plays.length > MAX_RECOG_ONLY_TTS_PLAYS) plays.shift()
        audio.onended = () => { play.ended = true; cleanup() }
        audio.onerror = () => { play.error = true; cleanup() }
        try {
          await audio.play()
          play.playResult = 'resolved'
        } catch (e) {
          play.playResult = recogErrorName(e)
          throw e
        }
      } else if (experiment.legacyMute) {
        // legacymute：読み上げの記録（play() を呼ぶ直前に作る）
        const play: LegacyTtsPlay = {
          afterRecordingNo: muteRecordingCountRef.current > 0 ? muteRecordingCountRef.current : null,
          trackStatesBeforePlay: streamRef.current?.getTracks().map(describeTrack) ?? [],
          playCalledAt: perfNow(),
          playResult: null,
          ended: false,
          error: false,
        }
        muteTtsPlaysRef.current.push(play)
        if (muteTtsPlaysRef.current.length > MAX_LEGACY_MUTE_TTS_PLAYS) muteTtsPlaysRef.current.shift()
        audio.onended = () => { play.ended = true; cleanup() }
        audio.onerror = () => { play.error = true; cleanup() }
        try {
          await audio.play()
          play.playResult = 'resolved'
        } catch (e) {
          play.playResult = e instanceof Error || e instanceof DOMException ? e.name : typeof e
          throw e
        }
      } else {
        await audio.play()
      }
    } catch (e) {
      // 表示する文言がないエラー（ネットワークのエラー、timeout など）は、ログにだけ残して何も表示しない
      logApiError('/api/tts', e)
      if (e instanceof ApiError && e.messageKey) showMessage(e.messageKey)
      setStatus('ready')
    } finally {
      clearTimeout(timer)
    }
  }

  const handleEditStart = () => {
    if (!recognizedText) return
    setEditValue(recognizedText)
    setIsEditing(true)
  }

  const handleEditConfirm = () => {
    if (!isEditing) return
    setIsEditing(false)
    const trimmed = editValue.trim()
    if (!trimmed || trimmed === recognizedText) return
    recognizedTextRef.current = trimmed
    setRecognizedText(trimmed)
    callTranslateApi(trimmed)
  }

  const handleEditChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditValue(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = `${e.target.scrollHeight}px`
  }

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditConfirm() }
    if (e.key === 'Escape') setIsEditing(false)
  }

  const canEdit = !!recognizedText && !isEditing && status !== 'recording' && status !== 'processing'

  const canTapFlag = (i: 0 | 1): boolean => {
    if (status === 'processing' || status === 'speaking') return false
    if (status === 'recording') return recordingFlagIndex === i
    return true
  }

  return (
    <main className="interpreter-page">
      <header className="interpreter-header">
        <h1 className="interpreter-title" onClick={onBack} role="button" aria-label="トップ画面へ戻る">GoTalk</h1>
      </header>

      {selectedLanguages.length === 2 && (
        <div className="lang-flags-bar">
          {status !== 'recording' && (
            <p className="lang-flags-bar__guide">
              {FLAG_TAP_MESSAGES[selectedLanguages[0].id] ?? FLAG_TAP_MESSAGES['en']}
            </p>
          )}
          <div className="lang-flags-bar__flags">
            {([0, 1] as const).map(i => {
              const lang = selectedLanguages[i]
              const isThisRecording = status === 'recording' && recordingFlagIndex === i
              return (
                <button
                  key={lang.id}
                  type="button"
                  className={[
                    'lang-flags-bar__btn',
                    isThisRecording ? 'lang-flags-bar__btn--recording' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => handleFlagTap(i)}
                  disabled={!canTapFlag(i)}
                  aria-pressed={isThisRecording}
                  aria-label={isThisRecording ? `${lang.label}の録音を停止` : `${lang.label}で話す`}
                >
                  <img
                    className="lang-flags-bar__flag"
                    src={`/flags/${lang.id}.svg`}
                    alt={lang.label}
                  />
                  {isThisRecording && (
                    <>
                      <div className="flag-ripple" ref={el => { rippleRefs.current[0] = el }} />
                      <div className="flag-ripple" ref={el => { rippleRefs.current[1] = el }} />
                      <div className="flag-ripple" ref={el => { rippleRefs.current[2] = el }} />
                    </>
                  )}
                </button>
              )
            })}
          </div>
          {status !== 'recording' ? (
            <p className="lang-flags-bar__guide">
              {FLAG_TAP_MESSAGES[selectedLanguages[1].id] ?? FLAG_TAP_MESSAGES['en']}
            </p>
          ) : recordingFlagIndex !== null ? (
            <div className="lang-flags-bar__scroll-wrap">
              <p className="lang-flags-bar__scroll-text">
                {FLAG_FINISH_MESSAGES[selectedLanguages[recordingFlagIndex].id] ?? FLAG_FINISH_MESSAGES['en']}
              </p>
            </div>
          ) : null}
        </div>
      )}

      <div className="page-content">
        <div className="source-card">
          {isEditing ? (
            <textarea
              ref={editRef}
              className="source-card__textarea"
              value={editValue}
              onChange={handleEditChange}
              onBlur={handleEditConfirm}
              onKeyDown={handleEditKeyDown}
              rows={1}
              aria-label="原文を編集"
            />
          ) : (
            <p className={`source-card__text${!recognizedText ? ' source-card__text--placeholder' : ''}`}>
              {recognizedText}
            </p>
          )}
          <button
            type="button"
            className="source-card__edit"
            onClick={handleEditStart}
            disabled={!canEdit}
            aria-label="編集"
          >
            <EditIcon />
          </button>
        </div>

        {status === 'recording' && liveTranslatedText && (
          <div className="live-translation-card">
            <p className="live-translation-card__text">{liveTranslatedText}</p>
          </div>
        )}

        {status !== 'recording' && (
          <div className="translation-card">
            <div className="translation-card__body">
              <div className="translation-card__main">
                <p
                  key={status === 'processing' ? processingMsgIdx : 'text'}
                  className={`translation-card__text${
                    status === 'processing' ? ' translation-card__text--processing' :
                    !translatedText ? ' translation-card__text--placeholder' : ''
                  }`}
                >
                  {status === 'processing' && processingLangs
                    ? [
                        `${TRANSLATING_MESSAGES[processingLangs[0]] ?? 'ただいま翻訳中です'}\n${TRANSLATING_MESSAGES[processingLangs[1]] ?? 'ただいま翻訳中です'}`,
                        `${PLEASE_WAIT_MESSAGES[processingLangs[0]] ?? 'しばらくお待ちください'}\n${PLEASE_WAIT_MESSAGES[processingLangs[1]] ?? 'しばらくお待ちください'}`,
                      ][processingMsgIdx]
                    : translatedText
                  }
                </p>
                <div className="back-translation-section">
                  <div className="back-translation-header">
                    <ChevronIcon />
                    <span>{backTranslationLabel}</span>
                  </div>
                  {backTranslation && (
                    <p className="back-translation-text">{backTranslation}</p>
                  )}
                </div>
              </div>

              {translatedText && (
                <button
                  type="button"
                  className={`speak-icon-button${status === 'speaking' ? ' speak-icon-button--speaking' : ''}`}
                  onClick={handleSpeak}
                  disabled={status === 'processing' || status === 'speaking'}
                  aria-label="発声する"
                >
                  <SpeakerIcon />
                </button>
              )}
            </div>
          </div>
        )}

        {history.length > 0 && (
          <div className="history-section">
            {history.map(item => (
              <div key={item.id} className="history-item">
                <div className="history-item__meta">
                  <span className="history-item__date">{item.date}</span>
                  <span className="history-item__time">{item.time}</span>
                </div>
                <div className="history-item__content">
                  <p className="history-item__source">{item.source}</p>
                  <p className="history-item__translation">{item.translation}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {errorMessage && (status === 'idle' || status === 'ready') && (
          <p className="error-text" role="alert">{errorMessage}</p>
        )}
      </div>

      {experiment.enabled && <ExperimentPanel
        config={experiment}
        // 録音の確定（onstop と翻訳の結果）の前に押せないよう、processing の間も押せなくする（LL1）。
        // processing への変化は 07f06f0 にもともとある再描画なので、新しい state や再描画は足さない
        busy={status === 'recording' || status === 'processing'}
        read={() => (experiment.recogOnly ? {
          // recogonly：記録の写し（配列と、その中の配列も写す）
          kind: 'recogonly',
          takenAt: new Date().toISOString(),
          effective: [...experiment.effective],
          config: { raw: experiment.raw, requested: experiment.requested, ignored: experiment.ignored, inactive: experiment.inactive, effective: experiment.effective },
          diagnostics: {
            recordings: recogDiagRef.current.recordings.map(r => ({
              ...r, events: r.events.map(e => ({ ...e })), restartErrors: [...r.restartErrors], silenceBeforeAutoEndMs: [...r.silenceBeforeAutoEndMs],
            })),
            ttsPlays: recogDiagRef.current.ttsPlays.map(p => ({ ...p })),
            recognitionStarts: { ...recogDiagRef.current.recognitionStarts },
          },
        } : {
          kind: 'legacy',
          takenAt: new Date().toISOString(),
          effective: [...experiment.effective],
          config: { raw: experiment.raw, requested: experiment.requested, ignored: experiment.ignored, inactive: experiment.inactive, effective: experiment.effective },
          recordings: legacyRecordingsRef.current.map(r => (r.keepStream
            ? { ...r, dataSizes: [...r.dataSizes], keepStream: { ...r.keepStream, trackStates: [...r.keepStream.trackStates],
              // legacymute：track の有効と無効の記録も写す（legacykeep のときは項目を足さない）
              ...(r.keepStream.trackStatesAfterEnable ? { trackStatesAfterEnable: [...r.keepStream.trackStatesAfterEnable] } : {}),
              ...(r.keepStream.trackStatesAfterDisable ? { trackStatesAfterDisable: [...r.keepStream.trackStatesAfterDisable] } : {}) } }
            : { ...r, dataSizes: [...r.dataSizes] })),
          // legacymute：読み上げの記録（すべて。写しを入れる）
          ...(experiment.legacyMute ? { ttsPlays: muteTtsPlaysRef.current.map(p => ({ ...p, trackStatesBeforePlay: [...p.trackStatesBeforePlay] })) } : {}),
        })}
      />}

    </main>
  )
}

function EditIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}


function SpeakerIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
      <path d="M15.54 8.46a5 5 0 010 7.07" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
