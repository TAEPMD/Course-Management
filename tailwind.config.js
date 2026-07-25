/**
 * tailwind.config.js
 *
 * แทนที่ config ที่เคยเขียน inline ไว้ใน index.html ตอนใช้ cdn.tailwindcss.com
 * ค่าต้องตรงกับของเดิม ไม่งั้นหน้าตาจะเพี้ยน
 *
 * `content` ต้องกวาด src/ ทั้งหมด เพราะ class ส่วนใหญ่ถูกประกอบเป็นสตริงใน
 * template literal ของ JS ไม่ได้อยู่ใน HTML
 */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './preview-*.html',
    './src/**/*.js',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Sarabun', '"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
      },
    },
  },
};
