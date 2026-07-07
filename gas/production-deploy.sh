#!/bin/bash
# ==========================================
# NIEM Training System — Production Deploy
# ==========================================
# Script to prepare files for Google Apps Script deployment

echo "📦 Preparing Production Deployment..."

# 1. Ensure dist folder exists
mkdir -p dist

# 2. Copy index.html to dist (production HTML)
echo "📄 Copying index.html to dist/"
cp index.html dist/index.html

# 3. Copy Code.gs to dist (for reference)
echo "📄 Copying Code.gs to dist/"
cp Code.gs dist/Code.gs

# 4. Create deployment notes
cat > DEPLOYMENT.md << 'EOF'
# Production Deployment Guide

## Prerequisites
- Google Apps Script Project linked to Google Sheets
- Folder "NIEM_Training_Docs" in Google Drive (auto-created)

## Deployment Steps

### 1. Deploy Backend (Code.gs)
1. Open Google Apps Script Editor
2. Copy entire `Code.gs` content
3. Paste into `Code.gs` file in Apps Script
4. Click "Deploy" → "New Deployment" → Choose "Web App"
5. Set "Execute as" to your account
6. Set "Who has access" to "Anyone"
7. Copy the deployment URL

### 2. Setup Database (One-time only)
1. Go to: Apps Script Editor → Extensions → Apps Script API
2. In Apps Script, click "Run" → function `setupDatabase()`
3. Wait for completion (creates all sheets)

### 3. Configure Admin PIN (Optional)
```javascript
// In Apps Script, run:
saveSystemSetting('adminPin', '12345');  // Change to your PIN
```

## Features
✅ Document upload to Google Drive
✅ Document download (view/download links)
✅ Document delete (removes from Sheet + Drive)
✅ Project management & scheduling
✅ User & attendance tracking

## File Structure
- `Code.gs` — Backend (Google Apps Script)
- `index.html` — Frontend (compiled, production-ready)
- `src/main.js` — Entry point (for development only)
- `dist/index.html` — Production HTML (deploy this)

## Development vs Production
- **Dev Mode**: `npm run dev` → Localhost with hot reload
- **Prod Mode**: Deploy `Code.gs` + `dist/index.html` to Google Apps Script

## Troubleshooting
- **Upload fails**: Check "NIEM_Training_Docs" folder exists in Drive
- **Auth fails**: Run setupDatabase() first, verify admin PIN
- **Documents don't persist**: Check Project sheet column 16 (Docs JSON)

## Links
- Google Apps Script: https://script.google.com/
- Google Drive: https://drive.google.com/
- Google Sheets: https://sheets.google.com/

---
Generated: 2025-05-12
Version: 1.0.0
EOF

echo "✅ Production files ready in ./dist/"
echo "✅ Deployment guide created: DEPLOYMENT.md"
echo ""
echo "Next steps:"
echo "1. Copy Code.gs to Google Apps Script"
echo "2. Deploy as Web App"
echo "3. Copy dist/index.html content to index.html in Apps Script"
echo ""
