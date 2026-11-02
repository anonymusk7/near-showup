// Source of widget/vendor/qr.js. QR codes are drawn locally (no QR web service).
import QRCode from 'qrcode';
export const toDataURL = (text, opts) => QRCode.toDataURL(text, { margin: 1, width: 220, ...opts });
