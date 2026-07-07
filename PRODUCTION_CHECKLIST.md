# ✅ Production Deployment Checklist

## 📋 Pre-Deployment

- [ ] All code committed to version control
- [ ] Tested in dev mode: `npm run dev`
- [ ] Verified all features work:
  - [ ] Login with PIN
  - [ ] Create new project
  - [ ] Upload document
  - [ ] Download document
  - [ ] Delete document
  - [ ] Save project info

## 🚀 Deployment Steps

### Phase 1: Prepare Files
- [ ] Review `Code.gs` for any pending changes
- [ ] Confirm `dist/index.html` exists and updated
- [ ] Check `.clasp.json` has empty `scriptId` (will be filled)
- [ ] Review `DEPLOYMENT.md` for completeness

### Phase 2: Create Google Apps Script
- [ ] Go to https://script.google.com
- [ ] Create new project named "NIEM Training System"
- [ ] Note the scriptId (Apps Script ID)
- [ ] Update `.clasp.json` with scriptId (optional, for clasp CLI)

### Phase 3: Deploy Backend
- [ ] Open Apps Script editor
- [ ] Copy entire `Code.gs` content
- [ ] Delete default `myFunction()`
- [ ] Paste `Code.gs` content
- [ ] Save file (Ctrl+S)

### Phase 4: Deploy Frontend
- [ ] In Apps Script: File → New → HTML file
- [ ] Name it: `index`
- [ ] Copy entire `dist/index.html` content
- [ ] Paste into HTML file
- [ ] Save file (Ctrl+S)

### Phase 5: Deploy Web App
- [ ] Click **Deploy** button
- [ ] Select deployment type: **Web app**
- [ ] Set "Execute as": [Your Google Account]
- [ ] Set "Who has access": **Anyone**
- [ ] Click **Deploy**
- [ ] Copy deployment URL
- [ ] ⭐ **SAVE THIS URL** (you'll need it later)

### Phase 6: Initialize Database
- [ ] Open Apps Script editor
- [ ] Click on `setupDatabase()` function
- [ ] Click **Run** button (▶️)
- [ ] Check **Execution log** for success message
- [ ] Verify sheets created:
  - [ ] Projects sheet
  - [ ] Users sheet
  - [ ] Registrations sheet
  - [ ] Attendance sheet

### Phase 7: First Login Test
- [ ] Open deployment URL from Phase 5
- [ ] Should see **Login** screen
- [ ] Enter PIN for a real Admin user from the Users sheet
- [ ] Click **Login**
- [ ] Should see **Dashboard**

## ✨ Post-Deployment Testing

### User Management
- [ ] Real production users appear from Google Sheets
- [ ] Can create new user
- [ ] Can edit user details
- [ ] Can delete user

### Project Management
- [ ] Can create new project
- [ ] Can edit project info
- [ ] Can view project list
- [ ] Can delete project
- [ ] Project data persists after refresh

### Document Management
- [ ] Can upload PDF
- [ ] Can upload image (PNG/JPG)
- [ ] Can upload document (DOC/DOCX/XLS/XLSX)
- [ ] Upload file appears in document table
- [ ] Can download uploaded document
- [ ] Can delete uploaded document
- [ ] Document deleted from Drive

### Schedule Management (if applicable)
- [ ] Can view annual plan
- [ ] Can view monthly plan
- [ ] Can view weekly plan
- [ ] Can edit schedule items

### Data Persistence
- [ ] Create project → Refresh page → Data still there ✓
- [ ] Upload document → Refresh page → Document still there ✓
- [ ] Delete document → Refresh page → Confirmed deleted ✓

## 🔒 Security Verification

### PIN Security
- [ ] Configured Admin PIN works (<real-admin-pin>)
- [ ] Cannot login with wrong PIN
- [ ] Session expires on logout
- [ ] Cannot access pages without login

### File Security
- [ ] Uploaded files accessible via Google Drive link
- [ ] Files marked as "Viewable - Anyone with link"
- [ ] Only authenticated users can delete
- [ ] Deleted files moved to Drive trash

## 📊 Performance Check

- [ ] Page loads in < 3 seconds
- [ ] File uploads complete smoothly
- [ ] No JavaScript errors (check console F12)
- [ ] Responsive on mobile devices

## 🐛 Troubleshooting Done?

- [ ] Tested slow network (throttle in DevTools)
- [ ] Tested with large file (> 5MB)
- [ ] Tested with different file types
- [ ] Cleared cache between tests

## 📝 Documentation

- [ ] DEPLOYMENT.md complete and accurate
- [ ] PRODUCTION_README.md created
- [ ] Code comments adequate
- [ ] Error messages user-friendly

## 👥 Admin Setup

### Admin PIN Change (Required)
1. Open Apps Script editor
2. Run custom function:
   ```javascript
   function changeAdminPin() {
     saveSystemSetting('adminPin', 'YOUR_SECURE_PIN_HERE');
   }
   ```
3. Replace `YOUR_SECURE_PIN_HERE` with new 4-6 digit PIN
4. Click Run
5. Next login: use new PIN

### Optional: Add More Users
1. In Production: Users menu
2. Add new users with unique PINs
3. Assign roles: Admin, Manager, Staff, etc.

## 📢 Go Live Preparation

- [ ] Notify stakeholders of deployment date
- [ ] Prepare user training materials
- [ ] Create backup of deployment URL
- [ ] Set up help desk / support email
- [ ] Schedule post-launch review meeting

## ✅ Final Sign-Off

- [ ] All tests passed ✓
- [ ] Documentation complete ✓
- [ ] Stakeholders notified ✓
- [ ] Backup deployment URL saved ✓
- [ ] Support process defined ✓

**Status**: Ready for Production ✅
**Date**: [Insert date]
**Deployed By**: [Insert name]
**Deployment URL**: [Insert URL here]

---

## 📋 Post-Launch Maintenance

### Weekly
- [ ] Check execution logs for errors
- [ ] Verify all uploads working
- [ ] Monitor Drive folder size

### Monthly
- [ ] Archive old projects
- [ ] Verify data backups
- [ ] Review user access

### Quarterly
- [ ] Security review
- [ ] Performance optimization
- [ ] Update admin PINs

### Annually
- [ ] Full system audit
- [ ] Feature roadmap review
- [ ] Technology update check

---

**System is now in PRODUCTION MODE! 🚀**
