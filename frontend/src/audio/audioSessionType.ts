// 音の扱い（Audio Session API の navigator.audioSession.type）を宣言する（docs/speech-flow.md の「9. TTS」）。
// iPhone は、マイクを開いていないときの AudioContext を効果音（Ambient）の扱いにするため、マナーモードでは読み上げが
// 鳴らない（WebKit Bug 252746）。マイクを開いた後と同じ「録音と再生」（play-and-record）を最初から宣言して、
// マナーモードでも鳴るようにする。マイクを開いた後の扱いと同じ値なので、録音の途中で扱いは変わらない。
// 通訳の画面の読み上げ（handleSpeak）からだけ呼ぶ

// 宣言する値。Audio Session API の type のうち、この部品で使うもの
const DECLARED_TYPE = 'play-and-record'

// Audio Session API のうち、この部品で使うものだけ（TypeScript の DOM の型にはないため）
interface AudioSession {
  type: string
}

export type DeclareAudioSessionResult =
  | { kind: 'set'; type: string }
  | { kind: 'unsupported' }
  | { kind: 'failed'; errorName: string }

function errorName(e: unknown): string {
  return e instanceof Error || e instanceof DOMException ? e.name : typeof e
}

// navigator.audioSession があれば type を play-and-record にする（冪等。すでにその値なら設定し直さない）。
// 対応していないブラウザでは何もしない。例外は捨てて、結果として返す
export function declarePlayAndRecord(): DeclareAudioSessionResult {
  try {
    const session = (navigator as Navigator & { audioSession?: AudioSession | null }).audioSession
    if (!session) return { kind: 'unsupported' }
    if (session.type !== DECLARED_TYPE) session.type = DECLARED_TYPE
    return { kind: 'set', type: String(session.type) }
  } catch (e) {
    return { kind: 'failed', errorName: errorName(e) }
  }
}
