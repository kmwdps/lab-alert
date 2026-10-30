# AYH Lab Result Alert

Tampermonkey userscript: เฝ้าดูผลแล็บวันนี้ใน iReportAG (ayhlab.ayhosp.go.th) ตาม HN สูงสุด 15 ราย เช็คทุก 5 นาที แจ้งเตือนเมื่อแล็บออก

## ติดตั้ง (ทำครั้งเดียวต่อเครื่อง)

1. ติดตั้ง [Tampermonkey](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo)
2. `chrome://extensions` → เปิด **Developer mode** → Tampermonkey → **Details** → เปิด **Allow User Scripts**
3. `chrome://settings/performance` → **Always keep these sites active** → Add `ayhlab.ayhosp.go.th`
4. เปิดลิงก์นี้ แล้วกด **Install**
   https://raw.githubusercontent.com/kmwdps/lab-alert/main/ayh-lab-alert.user.js
5. Refresh หน้า iReportAG → Result จะมีกล่องสีส้มมุมซ้ายล่าง

## ใช้งาน

- ใส่ HN (+ เตียง/ชื่อย่อ) → เพิ่ม · ✕ เพื่อเอาออก
- ⟳ เช็คทันที · ⏸ หยุด · ▼ ย่อ · 🔕 test ที่ไม่ต้องเตือน · 🔔 ทดสอบแจ้งเตือน
- ต้องล็อกอิน iReportAG ค้างไว้ และเปิดแท็บไว้ 1 แท็บ
- รายชื่อ HN เก็บแยกในแต่ละเครื่อง

## อัปเดต

Tampermonkey เช็คอัปเดตจาก repo นี้อัตโนมัติ (หรือ Dashboard → Utilities/Check for updates)
