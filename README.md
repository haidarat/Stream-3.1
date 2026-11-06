# Discord Custom RPC 🎮

ระบบแสดงสถานะ Discord Rich Presence ออนไลน์ 24/7 พร้อมหน้าเว็บ Dashboard ควบคุมและแก้ไขข้อมูลแบบ Real-time โดยไม่ต้องแก้ Code หรือแก้ Environment Variables ซ้ำอีกต่อไป

---

## 🚀 วิธีนำไป Deploy (สำหรับผู้ใช้งาน)

คุณสามารถนำโปรเจกต์นี้ไป Deploy บน [Render](https://render.com) หรือรันในเครื่องตัวเองได้ทันทีใน 3 ขั้นตอน:

### 1. ตั้งค่า Environment Variables (ใส่แค่ 3 บรรทัด!)

เมื่อ Deploy บน Render (หรือสร้างไฟล์ `.env` ในเครื่อง) ให้กรอกตัวแปรเพียงแค่นี้:

```env
TOKEN=ใส่_Discord_User_Token_ของคุณ
APPLICATION_ID=ใส่_Discord_Application_ID_ของคุณ
CENTRAL_API_URL=https://haidarat-stream-3-1.onrender.com
```

| ตัวแปร | จำเป็น | คำอธิบาย |
|--------|:---:|----------|
| `TOKEN` | ✅ | User Token ของบัญชี Discord ของคุณ |
| `APPLICATION_ID` | ✅ | Application ID จาก [Discord Developer Portal](https://discord.com/developers/applications) |
| `CENTRAL_API_URL` | ✅ | เซิร์ฟเวอร์กลางสำหรับบันทึกข้อมูล (ใส่ `https://haidarat-stream-3-1.onrender.com`) |

> 💡 **หมายเหตุ:** คุณ**ไม่ต้องมี Database** และ**ไม่ต้องสร้าง OAuth2 App** เอง ระบบจะเชื่อมต่อกับ Cloud Database กลางให้โดยอัตโนมัติ

---

### 2. เข้าใช้งานและแก้ไขสถานะผ่านหน้าเว็บ

1. เปิดเข้าไปที่ลิงก์เว็บของคุณ (เช่น `https://your-app-name.onrender.com` หรือ `http://localhost:3000`)
2. กดปุ่ม **"Login with Discord"** เพื่อยืนยันตัวตนผ่านบัญชี Discord
3. เมื่อเข้าสู่ระบบสำเร็จ จะสามารถ:
   - ปรับแต่งข้อความ, รูปภาพ (Large/Small Image), และปุ่มกด (Button 1 & 2)
   - ดูตัวอย่าง **Discord Presence Preview แบบ Real-Time ทันทีขณะพิมพ์**
   - กดปุ่ม **"Save & Hot-Reload"** ข้อมูลจะถูกอัปเดตขึ้น Discord ของคุณทันทีโดยไม่ต้อง Restart บอท

---

### 3. ตั้งค่าป้องกันเว็บหลับบน Render (ออนไลน์ 24/7 ฟรี)

Render แพ็กเกจฟรีจะเข้าสู่โหมดหลับหากไม่มีคนเข้าใช้งาน สามารถใช้ [cron-job.org](https://cron-job.org) เพื่อยิงปลุกบอทให้ออนไลน์ตลอดเวลาได้ฟรี:

1. สมัคร/ล็อกอินที่ **[cron-job.org](https://cron-job.org)**
2. กด **Create Cronjob**
3. ตั้งค่าตามนี้:
   - **Title:** `Keep-Alive RPC`
   - **URL:** `https://ชื่อแอปของคุณ.onrender.com/ping`
   - **Schedule:** เลือก **Every 5 minutes** (ทุกๆ 5 นาที)
4. กด **Create** เป็นอันเสร็จสิ้น! บอทจะออนไลน์ต่อเนื่องตลอด 24 ชั่วโมง

---

### 4. รันในเครื่องตัวเอง (Local Development)

```bash
# 1. ติดตั้ง dependencies
npm install

# 2. เริ่มต้นการทำงาน
npm start
```
เปิดบราวเซอร์ไปที่: `http://localhost:3000`
