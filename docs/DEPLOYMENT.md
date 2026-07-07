# 🚀 NIEM Training System — Deployment Guide

## Vercel Deployment

เวอร์ชันนี้ถูกปรับให้ deploy บน Vercel แบบ static ได้โดยตรงจาก root ของโปรเจกต์ ไม่ต้องพึ่ง `vite build` หรือ single-file mode สำหรับ GAS

### What Vercel Serves
- `index.html`
- `src/**/*.js`
- `src/style.css`
- `public/**`
- `vercel.json` ใช้สำหรับ fallback กลับมาที่ `index.html`

### Deploy Steps
1. Push repository นี้ขึ้น Git provider ที่ Vercel เชื่อมได้
2. สร้างโปรเจกต์ใหม่ใน Vercel แล้วเลือก repo นี้
3. ตั้งค่า Framework Preset เป็น `Other`
4. ตั้ง Environment Variable `GAS_WEB_APP_URL` เป็น URL ของ Apps Script Web App ฝั่ง backend ที่ deploy แล้ว
5. ปล่อย `Build Command` ว่าง หรือใช้ `echo static-site`
6. ปล่อย `Output Directory` ว่าง
7. Deploy ได้ทันที

### Required Backend For Real Uploads
- Apps Script ฝั่ง backend ต้อง deploy เป็น Web App และใช้ URL นั้นกับ `GAS_WEB_APP_URL`
- เมื่อกำหนดค่านี้แล้ว คำสั่ง `uploadFile` จากหน้า Vercel จะวิ่งผ่าน `/api/gas` ไปเรียก `DriveApp.createFile(...)` จริง
- Production mode requires `GAS_WEB_APP_URL` / `VITE_GAS_WEB_APP_URL`; if it is missing, the app shows an error and will not use offline/sample data.

### Runtime Behavior On Vercel
- แอปจะทำงานในโหมด browser-native static app
- Application data is read/written through Apps Script / Google Sheets only; there is no localStorage or offline/sample data fallback for production records.
- ฟีเจอร์ที่ต้องอาศัย `google.script.run` โดยตรงจะไม่ทำงานบน Vercel จนกว่าจะมี backend HTTP layer เพิ่มเติม

### Recommended Architecture
- Vercel: host frontend
- Google Apps Script: host spreadsheet / Drive automation backend
- ถ้าต้องการให้ Vercel ใช้ข้อมูลจริงจาก Google Sheets/Drive ควรเพิ่ม REST API หรือ serverless proxy แยกต่างหาก

## Overview
NIEM Training System is a **Google Apps Script + Sheets + Drive** application for course management with document uploads.

**Technology Stack:**
- **Backend**: Google Apps Script (Code.gs)
- **Frontend**: HTML + Vanilla JS + Tailwind CSS
- **Database**: Google Sheets
- **Storage**: Google Drive
- **Deployment**: Web App via Apps Script

---

## 📋 Prerequisites

1. **Google Account** with access to:
   - Google Apps Script (https://script.google.com)
   - Google Sheets (https://sheets.google.com)
   - Google Drive (https://drive.google.com)

2. **Files Ready**:
   - `Code.gs` — Backend logic
   - `dist/index.html` — Frontend (production build)

---

## 🔧 Step 1: Create Google Apps Script Project

### Option A: Create from Sheets (Recommended)
1. Go to https://sheets.google.com
2. Create new spreadsheet (e.g., "NIEM_Training_System")
3. Click **Tools** → **Script Editor**
4. This opens Apps Script editor linked to Sheets

### Option B: Create from Apps Script
1. Go to https://script.google.com
2. Click **New project**
3. Later, manually create/link a Spreadsheet

---

## 📝 Step 2: Deploy Backend Code

### 2.1 Copy Backend Code
1. Open `Code.gs` file from this project
2. Copy **entire content**
3. In Apps Script editor:
   - Delete default `myFunction()`
   - Paste entire `Code.gs` content

### 2.2 Create HTML File (if needed)
1. In Apps Script: **File** → **New** → **HTML**
2. Name it: `index`
3. Copy content from `dist/index.html`
4. Paste and save

### 2.3 Deploy as Web App
1. Click **Deploy** button (top right)
2. Choose **Deployments** icon (📦)
3. Click **New Deployment**
4. Select deployment type: **Web app**
5. Configure:
   - **Execute as**: [Your Google Account]
   - **Who has access**: "Anyone" (for public access)
   - Click **Deploy**

6. **Copy the deployment URL** (looks like):
   ```
   https://script.google.com/macros/d/{scriptId}/userweb
   ```
   (Or newer format: `https://script.google.com/macros/d/{scriptId}/userweb?v=1`)

---

## 🗄️ Step 3: Initialize Database (First Time Only)

1. Open the deployment URL from Step 2.3
2. You should see a **Login** screen
3. Go back to **Apps Script Editor**
4. In editor, find the `setupDatabase()` function
5. Click **Run** (▶️ button)
6. Authorize when prompted
7. Check **Execution log** for "✅ Database setup complete"

This creates sheets:
- **Projects** — Course projects with docs array (column 16)
- **Users** — User credentials
- **Registrations** — Enrollment data
- **Attendance** — Check-in logs

---

## 🔐 Step 4: Configure Admin PIN

The configured admin PIN is: **<real-admin-pin>**

To change it:
1. In Apps Script editor
2. Open **Logs** (at bottom)
3. Run this custom code:
   ```javascript
   function changeAdminPin() {
     saveSystemSetting('adminPin', 'YOUR_NEW_PIN');
   }
   ```
4. Click **Run**
5. Next login: use new PIN

---

## 📂 Step 5: Verify Google Drive Folder

The system automatically creates:
- **Folder**: "NIEM_Training_Docs" in your Google Drive (root)
- **Purpose**: Stores all uploaded documents

**Manual verification:**
1. Go to https://drive.google.com
2. Check for folder: "NIEM_Training_Docs"
3. Folder should exist after first file upload

---

## ✅ Step 6: Test the System

### 6.1 Login
1. Open deployment URL
2. Configured Admin PIN: **<real-admin-pin>**
3. Click **Login**

### 6.2 Create Project
1. Click **Create New Project**
2. Fill in:
   - Name: "Test Course"
   - Year: 2025
   - Status: "ร่าง" (Draft)
   - People: 30
   - Budget: 50000
3. Click **Save**

### 6.3 Upload Document
1. Go to **Documents** tab
2. Select a PDF/image file
3. Click **Upload**
4. Should see success message ✅

### 6.4 Download Document
1. Click **Download** icon (↓) next to document
2. Opens in new tab

### 6.5 Delete Document
1. Click **Delete** icon (🗑️) next to document
2. Confirm delete
3. Document removed from project + Drive

---

## 🔄 Step 7: Update/Redeploy Code

### For Backend Updates
1. Edit `Code.gs` in this project
2. Copy updated content
3. Paste into Apps Script `Code.gs`
4. Click **Deploy** → **Manage Deployments**
5. Select current deployment → **Create new version**
6. Wait ~30 seconds for changes to reflect

### For Frontend Updates
1. Edit `src/` files
2. Rebuild: `npm run dev` (for dev) or manually copy to `dist/index.html`
3. Copy new `dist/index.html` content
4. Update HTML file in Apps Script (if using inline HTML)
5. Redeploy

---

## 🐛 Troubleshooting

### Issue: "Upload Failed"
**Solution:**
- Check "NIEM_Training_Docs" folder exists in Drive
- Verify file size < 100MB
- Try different file format (PDF, PNG, JPG, etc)

### Issue: "Unauthorized: Please login with PIN"
**Solution:**
- Verify database initialized (run `setupDatabase()`)
- Check PIN is correct (configured in Users sheet)
- Clear browser cache

### Issue: "Documents don't persist after refresh"
**Solution:**
- Check Projects sheet column 16 has JSON data
- Verify `saveProject()` completes without error
- Check execution logs for errors

### Issue: "Folder not found"
**Solution:**
- Run `setupDatabase()` again
- Or manually create "NIEM_Training_Docs" in Drive
- Edit `Code.gs` PropertiesService cache

### Issue: "Slow uploads"
**Solution:**
- Check file size
- For large files (> 10MB), use compression
- GAS has rate limits; wait between uploads

---

## 📊 Project Structure

```
Code Project/Course Management/
├── Code.gs                          ← Backend (Google Apps Script)
├── index.html                       ← Frontend (development)
├── dist/
│   └── index.html                   ← Frontend (production, deployed to GAS)
├── src/
│   ├── main.js                      ← Entry point
│   ├── gas.js                       ← GAS bridge layer
│   ├── modules/
│   │   ├── projects.js              ← Project management
│   │   ├── auth.js                  ← Authentication
│   │   ├── users.js                 ← User management
│   │   ├── schedule.js              ← Schedule management
│   │   └── ...
│   └── utils/
│       ├── format.js                ← Formatting utilities
│       └── ...
├── package.json                     ← Dev dependencies
├── vite.config.js                   ← Build configuration
├── .clasp.json                      ← Apps Script CLI config
└── DEPLOYMENT.md                    ← This file
```

---

## 🔒 Security Notes

### Authentication
- Users login with 4-digit PIN (stored in "Users" sheet)
- Session stored in browser localStorage + GAS PropertiesService
- configured admin PIN: <real-admin-pin> (change immediately!)

### File Access
- Files uploaded to Google Drive with "ANYONE_WITH_LINK" access (VIEW only)
- Users can download via Google Drive URL
- Delete functionality only for authenticated users

### Data Storage
- Projects data: Google Sheets (backed up automatically)
- Files: Google Drive (accessible via Drive UI)
- No external APIs or third-party services

---

## 📈 Scaling Considerations

### Current Limits
- Google Sheets: 10 million cells per sheet
- Google Drive: Unlimited storage (free tier: 15GB)
- Apps Script: 30 min execution time limit per run

### For Large Deployments
- Consider archiving old projects to separate sheet
- Implement pagination for large document lists
- Use Cloud Firestore for higher-scale data needs

---

## 📞 Support & Maintenance

### Scheduled Maintenance
- Monthly: Backup sheets data (Google Sheets auto-backup)
- Quarterly: Review and archive old projects
- Annually: Update admin PINs

### Monitoring
- Check **Execution logs** in Apps Script regularly
- Monitor Drive folder size
- Track user session activity

### Updates
- Check for new features/fixes in source code
- Test in dev environment first
- Deploy to production during low-usage hours

---

## 📄 License & Credits

**NIEM Training System**
- Organization: สถาบันการแพทย์ฉุกเฉินแห่งชาติ (NIEM)
- Version: 1.0.0
- Last Updated: May 12, 2025

**Built with:**
- Google Apps Script
- Tailwind CSS
- Vite
- Vanilla JavaScript

---

## 🎉 You're Ready!

Your NIEM Training System is now deployed and ready to use. 

**Happy learning! 📚**

For questions or issues, refer to troubleshooting section or contact your system administrator.
