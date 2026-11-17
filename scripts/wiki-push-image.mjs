// 用 isomorphic-git 把测试图推入 wiki（产品 wiki 通道同款机制）
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";

const PROJECT = "/home/alecshan/projects/github.com/image-bot-cf";
const raw = readFileSync(`${PROJECT}/.dev.vars`, "utf8");
const m = raw.match(/GITHUB_APP_ID=(\d+)/);
const pem = raw.split('GITHUB_PRIVATE_KEY="')[1].split('"\n')[0].replace(/\\n/g, "\n");
const key = createPrivateKey(pem);
const b64u = (b) => Buffer.from(b).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const si = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify({ iat: now - 60, exp: now + 600, iss: m[1] }))}`;
const jwt = `${si}.${cryptoSign("sha256", Buffer.from(si), key).toString("base64url")}`;
const tok = await (await fetch("https://api.github.com/app/installations/182631252/access_tokens", {
  method: "POST",
  headers: { authorization: `Bearer ${jwt}` },
})).json();
const onAuth = () => ({ username: "x-access-token", password: tok.token });

// 夹具：photo.jpg + 4×60KB COM（同 e2e）
const photo = readFileSync(`${PROJECT}/bench/photo.jpg`);
const segs = [photo.subarray(0, 2)];
for (let i = 0; i < 4; i++) {
  const payload = Buffer.alloc(60 * 1024, 0x51 + i);
  const len = payload.length + 2;
  segs.push(Buffer.from([0xff, 0xfe, (len >> 8) & 0xff, len & 0xff]), payload);
}
segs.push(photo.subarray(2));
const jpg = Buffer.concat(segs);

const dir = "/tmp/opencode/wiki-live";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

await git.clone({
  fs,
  http,
  dir,
  url: "https://github.com/AlanVane/org-notes.wiki.git",
  ref: "master",
  singleBranch: true,
  depth: 1,
  onAuth,
});
console.log("wiki clone ✓");

fs.mkdirSync(`${dir}/images`, { recursive: true });
fs.writeFileSync(`${dir}/images/wiki-test.jpg`, jpg);
await git.add({ fs, dir, filepath: "images/wiki-test.jpg" });
await git.commit({
  fs,
  dir,
  message: "Add wiki test image (metadata-heavy jpg)",
  author: { name: "image-bot-cf[bot]", email: "image-bot-cf[bot]@users.noreply.github.com" },
});
const pushRes = await git.push({ fs, http, dir, onAuth, force: false });
console.log("wiki push ✓", JSON.stringify(pushRes));
console.log(`夹具已入 wiki: images/wiki-test.jpg = ${(jpg.length / 1024).toFixed(1)} KB`);
