import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // エントリーポイント: DOM mount のみ、ユニットテスト対象外
        'src/main.tsx',
        // ページルーター: 状態管理のみ、E2E 向き
        'src/App.tsx',
        // 開発用デバッグページ: 本番機能なし
        'src/pages/TtsTestPage.tsx',
      ],
    },
  },
})
