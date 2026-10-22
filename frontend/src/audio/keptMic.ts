// ページ全体で1つのマイク（stream）を持つ（docs/speech-flow.md の「マイクの持ち方」）。
// 録音の後も、画面が外れても、ページを離れるとき（pagehide、unload）も閉じない（ページを離れるときはブラウザが閉じる）。
// React の部品の外にあるので、通訳の画面から言語の選択の画面に戻っても残る。
// track の stop() を呼ぶのは acquire() の中（ended の track があるときに取り直す前）だけ。アプリのどこからも、
// このファイルの外で、この stream の track の stop() を呼ばず、enabled も変えず、listener も付けない

// 診断に残す、track の ended の記録の数
const MAX_ENDED_EVENTS = 20

export interface KeptMicEndedEvent {
  at: number
  // stream の中の track の番号（0 から）
  track: number
}

let held: MediaStream | null = null
let pending: Promise<MediaStream> | null = null
let getUserMediaCallCount = 0
let endedEventList: KeptMicEndedEvent[] = []
// ended の listener を付けた track（同じ track に2回付けない）
let watchedTracks = new WeakSet<MediaStreamTrack>()

// 持っている stream に track が1つ以上あり、どれも ended でなければ、その stream を返す（同期）。それ以外は null
export function peekLive(): MediaStream | null {
  if (!held) return null
  const tracks = held.getTracks()
  if (tracks.length === 0 || tracks.some(t => t.readyState === 'ended')) return null
  return held
}

// ended の見張りは、ここだけが持つ。track は止めず、記録だけを残す（次の peekLive() が null になるので、
// 次の録音の開始で acquire() が取り直す）
const watchEnded = (stream: MediaStream) => {
  stream.getTracks().forEach((track, i) => {
    if (watchedTracks.has(track)) return
    watchedTracks.add(track)
    track.addEventListener('ended', () => {
      endedEventList.push({ at: Date.now(), track: i })
      if (endedEventList.length > MAX_ENDED_EVENTS) endedEventList.shift()
    })
  })
}

// マイクを取得する。getUserMedia を待っている間の要求には、同じ Promise を返す（2回 getUserMedia を呼ばない）。
// 使える stream を持っていれば、getUserMedia を呼ばずにそれを返す（古い stream を開いたまま上書きしないための守り。
// 今の経路では、セッションは peekLive() が null のときだけ呼ぶ）。失敗は呼び出し元にそのまま投げる
export function acquire(): Promise<MediaStream> {
  if (pending) return pending
  const live = peekLive()
  if (live) return Promise.resolve(live)
  if (held) {
    // 持っている stream は使えない（track がない、ended がある）。ended の track に stop() を呼んでも害はない
    held.getTracks().forEach(t => t.stop())
    held = null
  }
  getUserMediaCallCount += 1
  const request = navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      held = stream
      watchEnded(stream)
      return stream
    })
    .finally(() => {
      if (pending === request) pending = null
    })
  pending = request
  return request
}

// getUserMedia を呼んだ回数（診断とテストのため）
export function getUserMediaCalls(): number {
  return getUserMediaCallCount
}

// track の ended の記録（新しいものが後ろ。最大 20 件）
export function endedEvents(): KeptMicEndedEvent[] {
  return endedEventList.map(e => ({ ...e }))
}

// テストのためだけ。持っている stream、待っている Promise、回数、記録を空にする（track は止めない）。本番のコードからは呼ばない
export function resetKeptMicForTest(): void {
  held = null
  pending = null
  getUserMediaCallCount = 0
  endedEventList = []
  watchedTracks = new WeakSet()
}
