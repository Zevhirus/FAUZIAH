# Bot WhatsApp Non-Resmi: FAQ Edabu BPJS Kesehatan

Bot WhatsApp pakai **Baileys** (WhatsApp Web, tanpa verifikasi Meta/WABA) + **Gemini** yang menjawab dari `kb.md`.

## Cara jalan
1. Install Node.js 18+.
2. `npm install`
3. Salin `.env.example` jadi `.env`, isi `GEMINI_API_KEY` (gratis dari https://aistudio.google.com/apikey).
4. `npm start`
5. Scan QR di terminal: WhatsApp > Perangkat tertaut > Tautkan perangkat. Sebaiknya pakai nomor khusus bot, bukan nomor pribadi.
6. Chat ke nomor itu dari HP lain.

Perintah: `reset` untuk menghapus riwayat percakapan.

## Struktur
- `kb.md`: knowledge base (edit ini untuk menambah/mengubah jawaban)
- `index.js`: koneksi WhatsApp + panggilan Gemini
- `auth/`: sesi login WhatsApp (jangan di-commit/dibagikan; hapus untuk scan ulang)

## Catatan penting
- Baileys itu tidak resmi, jadi ada risiko nomor dibatasi/banned oleh WhatsApp. Pakai nomor khusus, jangan spam, jangan kirim broadcast, dan jangan chat duluan ke orang yang belum pernah menghubungi.
- Untuk jangka panjang atau skala besar, tetap lebih aman lewat WhatsApp Business API resmi.
- Knowledge base masih kecil, jadi seluruh isinya dimasukkan ke prompt. Kalau nanti membesar (puluhan halaman), baru pertimbangkan RAG/embedding.
- Riwayat chat disimpan di memori, hilang saat bot restart.
- Jalankan 24 jam di VPS dengan `pm2 start index.js --name edabu-bot`.
# FAUZIAH
