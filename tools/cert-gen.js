'use strict';

/**
 * 纯 Node 自签名证书生成（无需 openssl）
 *
 * 用途：让局域网写 HTTP 服务跑在 HTTPS 上，
 * 从而获得「安全上下文」——浏览器才允许摄像头与 BarcodeDetector。
 *
 * 实现：手写 DER/ASN.1 编码，用 node:crypto 生成 RSA 密钥与签名。
 * 只生成单张自签名证书，不做 CA 链。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ==================================================================
   ASN.1 DER 编码工具
   ================================================================== */

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}

const SEQ = (items) => tlv(0x30, Buffer.concat(items));
const SET = (items) => tlv(0x31, Buffer.concat(items));
const INT = (bufOrNum) => {
  let b;
  if (typeof bufOrNum === 'number') {
    const a = [];
    let v = bufOrNum;
    if (v === 0) a.push(0);
    while (v > 0) { a.unshift(v & 0xff); v = Math.floor(v / 256); }
    b = Buffer.from(a);
  } else {
    b = bufOrNum;
  }
  // 最高位为 1 时补 0x00，表示正数
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
const OID = (str) => {
  const parts = str.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const enc = [];
    enc.unshift(v & 0x7f);
    v = Math.floor(v / 128);
    while (v > 0) {
      enc.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    bytes.push(...enc);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const NULL = () => tlv(0x05, Buffer.alloc(0));
const OCTET = (buf) => tlv(0x04, buf);
const BITSTR = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const UTF8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const PRINTABLE = (s) => tlv(0x13, Buffer.from(s, 'ascii'));
const UTCTIME = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
            `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
};
const EXPLICIT = (n, content) => tlv(0xa0 + n, content);

/* OID 常量 */
const OID_RSA = '1.2.840.113549.1.1.1';
const OID_SHA256RSA = '1.2.840.113549.1.1.11';
const OID_CN = '2.5.4.3';
const OID_O = '2.5.4.10';
const OID_SAN = '2.5.29.17';
const OID_BASIC = '2.5.29.19';
const OID_KEYUSAGE = '2.5.29.15';
const OID_EXTKEY = '2.5.29.37';
const OID_SERVERAUTH = '1.3.6.1.5.5.7.3.1';

/* ==================================================================
   证书构建
   ================================================================== */

function nameCN(cn, org) {
  const attrs = [];
  if (org) attrs.push(SET([SEQ([OID(OID_O), UTF8(org)])]));
  attrs.push(SET([SEQ([OID(OID_CN), UTF8(cn)])]));
  return SEQ(attrs);
}

/** 把 IP 或域名编码进 SAN */
function sanExtension(hosts) {
  const items = [];
  for (const h of hosts) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
      // iPAddress [7] IMPLICIT OCTET STRING
      const parts = h.split('.').map(Number);
      items.push(tlv(0x87, Buffer.from(parts)));
    } else {
      // dNSName [2] IMPLICIT IA5String
      items.push(tlv(0x82, Buffer.from(h, 'ascii')));
    }
  }
  return SEQ([OID(OID_SAN), OCTET(SEQ(items))]);
}

/**
 * 生成自签名证书
 * @param {string[]} hosts 需要覆盖的 IP / 域名
 * @returns {{key:string, cert:string}}
 */
function generate(hosts = ['127.0.0.1', 'localhost']) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  const notAfter = new Date(Date.now() + 3650 * 24 * 3600 * 1000);

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // 保证正数

  const sigAlg = SEQ([OID(OID_SHA256RSA), NULL()]);
  const subject = nameCN('ChatDrop Local', 'ChatDrop');

  // 扩展
  // KeyUsage: digitalSignature(bit0) + keyEncipherment(bit2)
  // BIT STRING 的 unused bits = 5，内容 2 字节 0x05 0xA0
  const keyUsageExt = SEQ([
    OID(OID_KEYUSAGE),
    tlv(0x01, Buffer.from([0xff])),                        // critical = TRUE
    OCTET(BITSTR(Buffer.from([0x05, 0xa0]), 5)),
  ]);

  // BasicConstraints: cA = FALSE（空 SEQUENCE，默认值可省略，但显式更清晰）
  const basicExt = SEQ([
    OID(OID_BASIC),
    tlv(0x01, Buffer.from([0xff])),                        // critical = TRUE
    OCTET(SEQ([])),
  ]);

  const extensions = SEQ([basicExt, keyUsageExt, sanExtension(hosts)]);

  const tbs = SEQ([
    EXPLICIT(0, INT(2)),                    // version v3
    INT(serial),
    sigAlg,
    subject,                                 // issuer = subject（自签名）
    SEQ([UTCTIME(notBefore), UTCTIME(notAfter)]),
    subject,
    BITSTR(publicKey, 0),
    EXPLICIT(3, extensions),
  ]);

  // 签名
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(tbs);
  const signature = signer.sign(privateKey);

  const cert = SEQ([tbs, sigAlg, BITSTR(signature, 0)]);

  return {
    key: privateKey,
    cert: `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}

/* ==================================================================
   磁盘缓存
   ================================================================== */

/**
 * 确保证书存在，不存在则生成
 * @returns {{key:string, cert:string, daysLeft:number}}
 */
function ensureCert(certDir, hosts) {
  fs.mkdirSync(certDir, { recursive: true });
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      const key = fs.readFileSync(keyPath, 'utf8');
      const cert = fs.readFileSync(certPath, 'utf8');
      const x = new crypto.X509Certificate(cert);
      const validTo = new Date(x.validTo);
      const daysLeft = Math.floor((validTo - Date.now()) / 86400000);
      // 覆盖的主机对不上就重签
      const san = x.subjectAltName || '';
      const covered = hosts.every((h) => san.includes(h));
      if (daysLeft > 30 && covered) {
        return { key, cert, daysLeft, generated: false };
      }
    } catch { /* 损坏则重签 */ }
  }

  const { key, cert } = generate(hosts);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  fs.writeFileSync(certPath, cert, { mode: 0o644 });
  return { key, cert, daysLeft: 3650, generated: true };
}

module.exports = { generate, ensureCert };
