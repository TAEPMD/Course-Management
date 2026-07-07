# NIEM Training Course Management System

ระบบบริหารจัดการหลักสูตรฝึกอบรม สถาบันการแพทย์ฉุกเฉินแห่งชาติ (NIEM)
Frontend: Vite + vanilla JS · Backend: Google Apps Script (Google Sheets) · Hosting: Vercel

**Production:** https://course-management-blond.vercel.app

## โครงสร้างโปรเจกต์

```
index.html            หน้าเว็บหลัก (ทุก view อยู่ในไฟล์เดียว สลับด้วย JS)
src/
  main.js             จุดเริ่มต้นแอป ผูก event / router ระหว่าง view
  gas.js              Backend bridge — เลือกเรียก google.script.run หรือ /api/gas อัตโนมัติ
  style.css           สไตล์ทั้งหมด ⚠ มีธีมหลายชั้นเขียนทับกัน — แก้สีที่ "FINAL PASS" ท้ายไฟล์เท่านั้น
  modules/            โมดูลตามฟีเจอร์ (auth, projects, budget, users, settings, ...)
  utils/              ฟังก์ชันช่วย (courseMetrics, format)
api/gas.js            Vercel serverless proxy → Google Apps Script (ใช้ env GAS_WEB_APP_URL)
Code.gs               Backend GAS ตัวหลัก (push ด้วย clasp, ดู .clasp.json)
gas/Code.gs           Backend GAS เวอร์ชัน manual สำหรับ deploy เองผ่าน script.google.com
docs/                 คู่มือ deploy และ checklist
```

## พัฒนา

```bash
npm install
npm run dev        # localhost dev server
npm run build      # build ลง dist/
npm run preview    # เปิดดู build จริงที่ localhost:4173
```

ตั้งค่า `.env` ตาม `.env.example` (ต้องมี `VITE_GAS_WEB_APP_URL` ชี้ไปยัง GAS Web App)

## Deploy ขึ้น production

โปรเจกต์นี้ **ไม่ได้** deploy ผ่าน git push — ต้องรันเองทุกครั้งที่แก้โค้ด:

```bash
npx vercel deploy --prod --yes
```

(เชื่อมกับ Vercel project `course-management` ผ่าน `.vercel/project.json`)

ฝั่ง backend แก้ `Code.gs` แล้ว deploy ผ่าน Google Apps Script — ดู [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

## หมายเหตุเรื่อง CSS

`src/style.css` สะสมธีมหลายรุ่นที่เขียนทับกันด้วย `!important` (ธีมฐาน → ธีม Apple-style → readability pass → FINAL PASS)
กติกา: **ถ้าจะแก้สี/พื้นหลังของ sidebar หรือหน้า login ให้แก้ที่บล็อก FINAL PASS ท้ายไฟล์** แล้วตรวจผลด้วย
`npm run build && npm run preview` + เปิดดูจริง อย่าแก้ชั้นกลางเพราะจะโดนชั้นท้ายทับ
