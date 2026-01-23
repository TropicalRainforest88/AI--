# AI 原型設計系統

這是一個用於管理多個系統原型的項目，使用純靜態 HTML 構建，可直接通過 GitHub Pages 發布。

## 項目結構

```
AI原型/
├── index.html              # 首頁導航（所有系統入口）
├── README.md               # 項目說明文檔
├── shared/                 # 共享資源
│   ├── css/
│   │   └── common.css      # 通用樣式
│   ├── js/
│   │   └── (通用腳本)
│   └── images/
│       └── (共享圖片)
├── 审核中心/               # 審核中心系統原型
│   ├── index.html          # 系統首頁
│   ├── pending-list.html   # 待審核列表
│   ├── reviewed-list.html  # 已審核列表
│   └── ...
├── [其他系統]/             # 其他系統原型
│   ├── index.html
│   └── ...
```

## 如何添加新系統

1. 在根目錄創建新的文件夾，例如 `用户中心/`
2. 在新文件夾中創建 `index.html` 作為該系統的首頁
3. 編輯根目錄的 `index.html`，添加新系統的卡片鏈接

## 發布到 GitHub Pages

### 方法一：通過 GitHub 網頁設置

1. 將代碼推送到 GitHub 倉庫
2. 進入倉庫 Settings → Pages
3. Source 選擇 "Deploy from a branch"
4. Branch 選擇 `main`（或 `master`），文件夾選擇 `/ (root)`
5. 點擊 Save，等待部署完成
6. 訪問 `https://[用戶名].github.io/[倉庫名]/`

### 方法二：使用 GitHub Actions（推薦）

1. 在項目根目錄創建 `.github/workflows/deploy.yml`：

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: '.'
      - id: deployment
        uses: actions/deploy-pages@v4
```

2. 推送代碼後會自動部署

## 本地預覽

### 方法一：使用 Python（推薦）

```bash
# Python 3
python -m http.server 8000

# 然後訪問 http://localhost:8000
```

### 方法二：使用 Node.js

```bash
# 安裝 live-server
npm install -g live-server

# 運行
live-server
```

### 方法三：使用 VS Code

安裝 "Live Server" 擴展，右鍵點擊 HTML 文件選擇 "Open with Live Server"

## 系統列表

| 系統名稱 | 狀態 | 說明 |
|---------|------|------|
| 審核中心 | ✅ 已完成 | 訂單審核、商戶管理、權限配置等 |
| (待添加) | - | - |

## 開發規範

1. **文件命名**：使用小寫字母和短橫線，如 `pending-list.html`
2. **樣式引用**：優先使用 `shared/css/common.css` 中的通用樣式
3. **頁面結構**：保持統一的側邊欄和頂部導航結構
4. **原型標記**：頁面應清楚標明這是原型，數據為模擬數據
