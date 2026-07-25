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
  style.css           สไตล์ทั้งหมด (มี @tailwind อยู่บนสุด) ⚠ มีธีมหลายชั้นเขียนทับกัน
  modules/            โมดูลตามฟีเจอร์ (auth, projects, budget, users, settings, ...)
  utils/              ตรรกะล้วนที่เทสต์ได้ (courseMetrics, budgetWorkflow, format)
api/gas.js            Vercel serverless proxy → Google Apps Script (ใช้ env GAS_WEB_APP_URL)
api/_authProxy.js     ตัวช่วยความปลอดภัยที่ proxy กับ vite dev ใช้ร่วมกัน
tests/                เทสต์ (node:test — ไม่ต้องลง dependency เพิ่ม)
tailwind.config.js    config ของ Tailwind (เดิมเขียน inline ไว้ใน index.html)
Code.gs               Backend GAS ตัวหลัก (push ด้วย clasp, ดู .clasp.json)
gas/Code.gs           Backend GAS เวอร์ชัน manual สำหรับ deploy เองผ่าน script.google.com
docs/                 คู่มือ deploy และ checklist
preview-*.html        harness ไว้ดู UI โดยไม่ต้องล็อกอิน (budget / gantt / login)
```

## พัฒนา

```bash
npm install
npm run dev        # localhost dev server
npm test           # เทสต์ตรรกะ (node:test) — ควรรันก่อน commit ทุกครั้ง
npm run build      # build ลง dist/
npm run preview    # เปิดดู build จริงที่ localhost:4173
```

ดู UI โดยไม่ต้องล็อกอิน: `npm run dev` แล้วเปิด `preview-budget.html`,
`preview-gantt.html`, `preview-login.html` (harness จะ seed ข้อมูลตัวอย่างให้เอง)

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

Tailwind ถูก **build ตอน compile** (ดู `tailwind.config.js` + `postcss.config.js`) ไม่ได้โหลดจาก
`cdn.tailwindcss.com` แล้ว — ตัวนั้นส่ง JIT compiler มา compile ในเบราว์เซอร์ ทำให้หน้าเว็บช้า
และบังคับให้ CSP ต้องเปิด `unsafe-eval`

⚠ `content` ใน `tailwind.config.js` ต้องกวาด `src/**/*.js` ด้วย เพราะ class ส่วนใหญ่ถูกประกอบ
เป็นสตริงใน template literal ของ JS **อย่าสร้างชื่อ class ของ Tailwind แบบต่อสตริง**
(เช่น `` `bg-${tone}-500` ``) เพราะตอน build จะหาไม่เจอแล้วสีหาย — ให้เขียนชื่อเต็มเป็นสตริงตรง ๆ

## ความปลอดภัยฝั่งการแสดงผล

หน้าเว็บนี้ประกอบ HTML ด้วย template literal เป็นหลัก จึงต้อง escape เองเสมอ:

- แทรกเป็น **เนื้อหา/attribute ปกติ** → `escapeHTML(value)`
- แทรกใน **สตริง JS ที่อยู่ใน attribute** เช่น `onclick="app.openProject('...')"` → `escapeJsAttr(value)`

`escapeHTML` อย่างเดียวไม่พอสำหรับกรณีหลัง เพราะเบราว์เซอร์ decode HTML entity ก่อน
แล้วค่อย parse เป็น JavaScript — `&#39;` จะกลายเป็น `'` และปิดสตริงได้ (มีเทสต์คุมไว้ใน
`tests/format.test.js`) · เพิ่ม action ใหม่ของ API ต้องแก้ 3 ที่ ดู [docs/SECURITY.md](docs/SECURITY.md)
