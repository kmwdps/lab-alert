# HANDOFF — AYH Lab Result Alert

สรุปสำหรับคนที่จะมาแก้/ดูแลต่อ (อัปเดตล่าสุด: 30 ต.ค. 2569, v1.8)

## คืออะไร

Tampermonkey userscript บนหน้า iReportAG ของ รพ.พระนครศรีอยุธยา
(`https://ayhlab.ayhosp.go.th/iReportAG/Home/Result`) — ใส่ HN สูงสุด 15 ราย
สคริปต์เช็คผลแล็บ **ของวันนี้** ทุก 5 นาที แล้วแจ้งเตือน (Windows notification + เสียง + ชื่อแท็บกะพริบ)
เมื่อมีแล็บออก โดยบอก HN + ชื่อคนไข้ + ชื่อ test ที่ออก

- ไฟล์หลัก: `ayh-lab-alert.user.js`
- ติดตั้ง/อัปเดต: `https://raw.githubusercontent.com/kmwdps/lab-alert/main/ayh-lab-alert.user.js`
  (`@updateURL`/`@downloadURL` ชี้ที่นี่ → ทุกเครื่องอัปเดตเองเมื่อ `@version` เพิ่ม)
- repo ต้องเป็น Public ไม่งั้นติดตั้ง/อัปเดตไม่ได้

## โครงสร้างหน้าเว็บ (สิ่งที่ค้นพบ)

- `Home/Result` เป็นแค่กรอบนอก — ช่องค้นหาและตารางอยู่ใน iframe `#FamSearch`
  ที่โหลด `/iReportAG/Result/ResView/Search`
- ช่องค้นหา: `input` ที่ placeholder มีคำว่า `HN` ("HN, Name, ID card")
- ปุ่ม: ข้อความ `Search` (เลือกตัวที่อยู่ต่ำสุดบนจอ เพื่อไม่ชนกับแท็บ "Search" ด้านบน)
- ตาราง: jqGrid (`tr` ต่อ request), ใช้ jQuery 3.7
- คอลัมน์ **St**: สี่เหลี่ยมเล็ก **แดง = ยังไม่ออก**, **ฟ้า = ออกแล้ว**
- Request Time รูปแบบ `dd/mm/yyyy HH:MM` (ค.ศ.) — รองรับ พ.ศ. ด้วย
- ชื่อ test อยู่ในบรรทัด `Test: ...` (แถวเดียวกันหรือแถวถัดไป)
- เมื่อหลุดล็อกอิน → มี `input[type=password]`

## หลักการทำงาน

1. สร้าง iframe ซ่อน (offscreen, `sandbox="allow-scripts allow-same-origin allow-forms"`) โหลดหน้า Search
   ใหม่ทุกครั้งต่อ 1 HN; อ่าน `contentDocument` ใหม่ทุกครั้ง (หน้าอาจโหลดซ้ำหลัง onload)
2. กรอก HN (native setter + input/change/keyup) → คลิก Search (pointer/mouse events + click)
3. รอผล: ดึงแถวที่มี HN นั้น จนผลนิ่ง 2 รอบ (timeout 20 วิ)
4. แยกแถว: หา element ขนาด 5–30px ที่ `background-color` แดง/ฟ้า → ขึ้นไปหา `tr`
5. กรองเฉพาะวันนี้ + ตัด test ที่อยู่ในรายการไม่เตือน (ตัดราย test; ถ้าทั้งใบถูกตัด = ข้ามใบ)
6. เทียบกับ `seen` (key = Request No.) → ใบที่ฟ้าใหม่ = แจ้งเตือน
   - เพิ่ม HN ครั้งแรก = baseline เงียบ (ไม่เตือนของที่ออกไปแล้ว)
7. ใช้ Worker-based `sleep()` กัน Chrome หน่วง timer ตอนแท็บอยู่เบื้องหลัง

## ข้อมูลที่เก็บ

- `GM_setValue('ayhLabAlert.v1')`: `patients[] {hn, seen[], baseline, status, err, checkedAt}`,
  `ignore[]`, `ignoreVer`
- เก็บแยกต่อเครื่อง/ต่อ browser, **ไม่เก็บชื่อคนไข้** (อ่านจากตารางตอนแจ้งเตือนเท่านั้น)
- ไม่ส่งข้อมูลออกนอกเครื่อง

## รายการไม่เตือน (ค่าเริ่มต้น, แก้ได้ที่ปุ่ม 🔕)

Hemo C/S, Urine C/S, Sputum C/S, Gram Stain, ABO Group (Gel Test), Rh Group (Gel Test),
Indirect Coombs' test (Gel Test), HBsAg, Anti-HBs, Anti-HCV, HIV Ab (CMI)
— match แบบ substring ไม่สนตัวพิมพ์ · เพิ่มค่า default ใหม่ให้เครื่องเดิม: แก้ `DEFAULT_IGNORE` แล้วเพิ่ม `ignoreVer`

## UI (กล่องส้มมุมซ้ายล่าง)

ช่อง HN + เพิ่ม · ✕ เอาออก · ⟳ เช็คทันที · ⏸ หยุด · ▼ ย่อ · 🔕 รายการไม่เตือน ·
🔔 ทดสอบ (หน่วง 5 วิ) · Debug (คัดลอกโครงสร้างหน้าเว็บไป clipboard)

## ข้อกำหนดการใช้งาน

- Tampermonkey + Developer mode + **Allow User Scripts** (Chrome รุ่นใหม่)
- `chrome://settings/performance` → Always keep active: `ayhlab.ayhosp.go.th`
- ล็อกอิน iReportAG ค้างไว้, เปิดแท็บ Result ไว้ **1 แท็บ** ต่อเครื่อง
- คลิกหน้าเว็บ 1 ครั้งหลังเปิด เพื่อให้เสียงเล่นได้

## วิธีแก้ปัญหา

- ⚠ หาช่องค้นหา/ปุ่มไม่เจอ หรือนับผิด → กด **Debug** แล้วดู JSON (navLog, searchCandidates, sampleRow)
- ชื่อคนไข้ไม่ขึ้น/ผิด → ดู `findName()` (ใช้ `aria-describedby` ของ jqGrid ก่อน แล้ว fallback คำนำหน้าชื่อไทย)

## ปล่อยเวอร์ชันใหม่

1. แก้ `ayh-lab-alert.user.js`
2. **เพิ่ม `@version`** (ไม่เพิ่ม = เครื่องอื่นไม่อัปเดต)
3. `node --check ayh-lab-alert.user.js`
4. commit + push `main`

## ประวัติเวอร์ชัน

- 1.0 เวอร์ชันแรก
- 1.1–1.3 แก้หาช่องค้นหา: อ่าน document สด, โหลด `/Result/ResView/Search` ตรง
- 1.4 รายการไม่เตือน · 1.5 ปุ่มทดสอบแจ้งเตือน
- 1.6 ค่า default ไม่เตือน 11 รายการ, ตัดราย test, UI 🔕, `@updateURL`
- 1.7 ชื่อคนไข้ในหัวแจ้งเตือน · 1.8 เอาช่องเตียงออก (แจ้งแค่ HN + ชื่อ)

## ไอเดียที่ยังไม่ได้ทำ

- ส่งเข้ามือถือ (Telegram/ntfy) — ต้องระวัง PDPA: ไม่ส่งชื่อ/ค่าแล็บออกนอกเครือข่าย
- แจ้งค่าวิกฤต (critical value)
