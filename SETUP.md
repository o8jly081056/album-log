# SHeard · 設定教學

App 不做任何設定也能用（單機模式）。以下三步做完，就會有 **手機安裝、Spotify、跨裝置同步**。

網址預定為：`https://o8jly081056.github.io/sheard/`

---

## 1. 部署到 GitHub Pages（由 Claude 處理）

- 程式碼放在 GitHub 的 `sheard` repo，GitHub Pages 會**自動**把它發佈成網站。
- 之後每次更新只要 `git push`，約 1 分鐘後網站就是新版，**不用手動重新部署**。
- 手機上已安裝的 App 下次打開會自動抓新版（若沒變，關掉 App 再開一次）。

### 手機安裝
- **iPhone**：用 Safari 打開網址 → 分享 → 「加入主畫面」
- **Android**：用 Chrome 打開 → 右上選單 → 「安裝應用程式」
- **電腦**：Chrome / Edge 網址列右邊的「安裝」圖示

---

## 2. Spotify（需要 Premium）

> 2026 年起 Spotify 規定：開發模式的 App，**擁有者必須是 Premium 會員**，最多 5 位使用者。

1. 到 <https://developer.spotify.com/dashboard> 用你的 Spotify 帳號登入 → **Create app**
2. 填寫：
   - App name：`SHeard`
   - Redirect URIs（兩個都加）：
     - `https://o8jly081056.github.io/sheard/`
     - `http://127.0.0.1:8644/`（電腦本機測試用）
   - 勾選 **Web API**
3. 建立後到 **Settings** 複製 **Client ID**
4. **User Management** → 把你自己的 Spotify Email 加進去

App 只會讀取：正在播放、最近播放、收藏的專輯。**不會自動標記任何東西**，一律你自己按。

---

## 3. 雲端同步（Supabase，免費）

1. 到 <https://supabase.com> 註冊 → **New project**（地區選 Tokyo 或 Singapore）
2. 左側 **SQL Editor** → 貼上 `supabase.sql` 全部內容 → **Run**
3. 左側 **Authentication → Sign In / Providers** → 點 **Email** → 把 **Confirm email** 關掉 → **Save**
   （App 用 Email＋密碼登入，不寄任何信，所以不需要設定 SMTP 或信件模板）
4. **Authentication → URL Configuration** → Site URL 填上面的網址
5. **Project Settings → API** 複製 **Project URL** 和 **anon / publishable key**

---

## 4. 填入設定

把三個值貼給 Claude，或自己填進 `config.js`：

```js
window.HEARD_CONFIG = {
  SPOTIFY_CLIENT_ID: '...',
  SUPABASE_URL: 'https://xxxx.supabase.co',
  SUPABASE_ANON_KEY: '...'
};
```

這三個值都是設計上可以公開的；資料安全由 Supabase 的資料列權限（每人只能看自己的）保護。
