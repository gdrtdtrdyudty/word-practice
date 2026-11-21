/* ============================================================
   背单词练习 · 本地服务
   - 提供静态页面（index.html）
   - POST /lookup : 把一组英文词转发给 DeepSeek，返回 校验+词性+中文
   - GET/POST /state : 词库 + 积分的共享存储（手机扫码同一份数据）
   - GET /info : 局域网地址与状态（前端用来生成二维码）
   - POST /key : 保存 API Key（手机端可直接复用电脑上的 Key）
   运行: node server.js   (默认 http://0.0.0.0:8111，监听局域网)
   无第三方依赖，Node 18+ 自带 fetch。
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');

const ROOT = __dirname;
const PORT = process.env.PORT || 8111;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.WP_DATA || path.join(ROOT, 'data.json');
const DS_URL = 'https://api.deepseek.com/chat/completions';
const MAX_WORDS = 120;             // 一次交给大模型的词数
const MAX_STATE_WORDS = 5000;      // 共享词库上限
const MAX_BODY = 2e6;

/* ---------- 局域网地址 ----------
   手机要和电脑连同一个 Wi-Fi，二维码里用电脑的局域网 IP。
   用 UDP connect 取"默认出口 IP"，这样能自动避开虚拟网卡（WSL / VirtualBox）。 */
function detectPrimaryIPv4(){
  return new Promise((resolve)=>{
    let done = false;
    const s = dgram.createSocket('udp4');
    const finish = (ip)=>{ if(done) return; done = true; try{ s.close(); }catch(e){} resolve(ip || ''); };
    try{
      s.on('error', ()=>finish(''));
      s.connect(53, '8.8.8.8', ()=>{ try{ finish(s.address().address); }catch(e){ finish(''); } });
      setTimeout(()=>finish(''), 1000);
    }catch(e){ finish(''); }
  });
}
function localIPv4List(){
  const out = [];
  const ifs = os.networkInterfaces();
  for(const name of Object.keys(ifs)){
    for(const a of ifs[name] || []){
      if(String(a.family) !== 'IPv4' && a.family !== 4) continue;
      if(a.internal) continue;
      if(/^169\.254\./.test(a.address)) continue;          // 链路本地，手机连不上
      out.push({ name, address: a.address });
    }
  }
  return out;
}

let LAN_IPS = [];
let PRIMARY_IP = '';
let ALLOWED_HOSTS = new Set();
let ALLOWED_HOSTNAMES = new Set();

function buildAllowlist(primary){
  LAN_IPS = localIPv4List().map(x=>x.address).filter((ip, i, arr)=>arr.indexOf(ip) === i);
  PRIMARY_IP = (primary && LAN_IPS.includes(primary)) ? primary : (LAN_IPS[0] || '');
  // 主 IP 排最前
  if(PRIMARY_IP){
    const i = LAN_IPS.indexOf(PRIMARY_IP);
    if(i > 0){ LAN_IPS.splice(i, 1); LAN_IPS.unshift(PRIMARY_IP); }
  }
  ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', ...LAN_IPS]);
  ALLOWED_HOSTS = new Set([...ALLOWED_HOSTNAMES].map(h=>h + ':' + PORT));
}
buildAllowlist('');   // 先用同步结果占位，启动前再用 detectPrimaryIPv4 修正

/* 换 Wi-Fi / 插拔网线后 IP 会变：定期重新探测，二维码和白名单自动跟着更新 */
async function refreshNetwork(){
  const before = LAN_IPS.join(',');
  buildAllowlist(await detectPrimaryIPv4());
  if(LAN_IPS.join(',') !== before) console.log('局域网地址已更新: ' + LAN_IPS.map(ip=>'http://'+ip+':'+PORT+'/').join('  '));
}
setInterval(()=>{ refreshNetwork().catch(()=>{}); }, 20000).unref?.();

function hostAllowed(req){
  return ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase());
}
function originAllowed(req){
  const o = req.headers.origin;
  if(!o) return true;                 // 无 Origin 头：地址栏导航 / 手机扫码 / curl
  if(o === 'null') return false;      // file:// 或沙箱 iframe
  try{
    const u = new URL(o);
    if(u.protocol !== 'http:') return false;
    const hn = u.hostname.toLowerCase();
    return (ALLOWED_HOSTNAMES.has(hn) || ALLOWED_HOSTNAMES.has('[' + hn + ']')) &&
      (!u.port || u.port === String(PORT));
  }catch(e){ return false; }
}
/* 所有响应统一附带的加固头 */
const SEC_HEADERS = {
  'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer',
  'Cache-Control':'no-store'
};

/* ---------- 共享数据（词库 + 积分 + Key） ---------- */
let state = { rev: 0, updatedAt: 0, words: [], points: null, key: '' };
function loadState(){
  try{
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if(!j || typeof j !== 'object') return;
    state.rev = Math.max(0, Number(j.rev) || 0);
    state.updatedAt = Math.max(0, Number(j.updatedAt) || 0);
    state.words = Array.isArray(j.words) ? j.words.map(cleanWord).filter(Boolean) : [];
    state.points = cleanPoints(j.points);
    state.key = typeof j.key === 'string' ? j.key : '';
    if(state.words.length || state.points || state.key) state.rev = Math.max(1, state.rev);
  }catch(e){}
}
function persistState(){
  const tmp = DATA_FILE + '.tmp';
  const body = JSON.stringify(state);
  try{
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, DATA_FILE);
  }catch(e){
    try{ fs.writeFileSync(DATA_FILE, body); }catch(e2){}
  }
}
function cleanWord(w){
  if(!w || typeof w !== 'object') return null;
  const en = String(w.en || '').trim().slice(0, 80);
  if(!en) return null;
  const id = String(w.id || '').slice(0, 40) || ('s' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  return {
    id,
    en,
    zh: String(w.zh || '').slice(0, 300),
    pos: String(w.pos || '').slice(0, 60),
    correct: Math.max(0, Math.min(1e6, Math.floor(Number(w.correct) || 0))),
    wrong: Math.max(0, Math.min(1e6, Math.floor(Number(w.wrong) || 0))),
    createdAt: Math.max(0, Number(w.createdAt) || Date.now())
  };
}
function cleanPoints(p){
  if(!p || typeof p !== 'object') return null;
  const n = (x)=>Math.max(0, Math.round((Number(x) || 0) * 10) / 10);
  return {
    total: n(p.total),
    fromWords: n(p.fromWords),
    fromCorrect: Math.max(0, Math.floor(Number(p.fromCorrect) || 0)),
    allWrong: Math.max(0, Math.floor(Number(p.allWrong) || 0)),
    penalty: n(p.penalty)
  };
}
loadState();

/* ---------- 静态文件 ---------- */
const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json','.svg':'image/svg+xml'};
function sendFile(req, res, file){
  const head = req.method === 'HEAD';
  fs.readFile(file, (err, buf)=>{
    if(err){ res.writeHead(404, Object.assign({'Content-Type':'text/plain; charset=utf-8'}, SEC_HEADERS)); res.end('Not Found'); return; }
    res.writeHead(200, Object.assign({'Content-Type': MIME[path.extname(file)]||'application/octet-stream'}, SEC_HEADERS));
    res.end(head ? undefined : buf);
  });
}

/* ---------- 调 DeepSeek：一次性校验多个词 ---------- */
async function callDeepSeek(key, words){
  const sys =
    '你是中英文词汇校验助手。用户会给出一批英文单词(可能是完整单词或带词形变化如复数/时态)。'+
    '对每个词判断：它是不是真实、可用的英文单词。'+
    '对真实单词：给出常用中文释义和词性缩写(如 n./v./adj./adv./prep./pron./conj. 等，多个词性用 / 连接，如 n./v.)。'+
    '对不是真实单词的(拼写错误、乱码、明显非英文)：valid=false。'+
    '严格只输出一个 JSON 对象，禁止任何额外文字、禁止 markdown 代码块。格式：'+
    '{"results":[{"word":"用户输入的原词","valid":true,"pos":"n.","zh":"苹果"}]}。'+
    'results 长度必须与输入单词一一对应、顺序一致。';
  const body = {
    model: 'deepseek-chat',
    messages: [
      { role:'system', content: sys },
      { role:'user', content: JSON.stringify({ words }) }
    ],
    temperature: 0,
    response_format: { type:'json_object' }
  };
  const res = await fetch(DS_URL, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+key },
    body: JSON.stringify(body)
  });
  if(!res.ok){
    const txt = await res.text().catch(()=>'');
    const err = new Error('DeepSeek HTTP '+res.status);
    err.dsStatus = res.status;
    err.detail = txt.slice(0,200);
    throw err;
  }
  const j = await res.json();
  const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if(!content) throw new Error('DeepSeek 返回了空内容');
  let data;
  try { data = JSON.parse(content); }
  catch(e){
    const m = content.match(/\{[\s\S]*\}/);
    if(m){ try { data = JSON.parse(m[0]); } catch(e2){ throw new Error('无法解析 DeepSeek 返回'); } }
    else throw new Error('无法解析 DeepSeek 返回');
  }
  if(!data || !Array.isArray(data.results)) throw new Error('DeepSeek 返回结构异常');
  return data.results;
}

/* 把 DeepSeek 结果按请求词对齐（model 偶有漏词/大小写变动） */
function align(words, raw){
  const map = new Map();
  for(const r of raw){
    const k = String(r.word||'').trim().toLowerCase();
    if(k) map.set(k, r);
  }
  return words.map(w => {
    const hit = map.get(w.toLowerCase());
    if(!hit) return { word:w, valid:false, pos:'', zh:'', reason:'miss' };
    return {
      word: w,
      valid: !!hit.valid,
      pos: String(hit.pos||'').trim(),
      zh: String(hit.zh||'').trim(),
      reason: hit.valid ? 'ok' : 'invalid'
    };
  });
}

/* ---------- HTTP 处理 ---------- */
function readBody(req){
  return new Promise((resolve, reject)=>{
    let d='', over=false;
    req.on('data', c=>{ if(over) return; d+=c; if(d.length>MAX_BODY) over=true; });
    req.on('end', ()=>{
      if(over){ const e=new Error('请求体过大'); e.tooLarge=true; return reject(e); }
      try{ resolve(JSON.parse(d||'{}')); }catch(e){ reject(e); }
    });
    req.on('error', reject);
  });
}
function json(res, code, obj){
  res.writeHead(code, Object.assign({'Content-Type':'application/json; charset=utf-8'}, SEC_HEADERS));
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res)=>{
  // 安全闸门：Host / Origin 必须在白名单内，否则一律拒绝
  if(!hostAllowed(req) || !originAllowed(req)){
    json(res, 403, { error:'forbidden', message:'仅允许通过本机或同一局域网的地址访问' });
    return;
  }
  const url = new URL(req.url, 'http://'+req.headers.host);
  try{
    /* ---- 共享数据 ---- */
    if(url.pathname === '/info' && req.method === 'GET'){
      // 当前主 IP 已经不在本机网卡上（刚换了网络）→ 立刻重新探测
      if(!PRIMARY_IP || !localIPv4List().some(x=>x.address === PRIMARY_IP)) { try{ await refreshNetwork(); }catch(e){} }
      json(res, 200, {
        port: Number(PORT),
        primary: PRIMARY_IP,
        ips: LAN_IPS,
        urls: LAN_IPS.map(ip=>'http://'+ip+':'+PORT+'/'),
        hasKey: !!state.key,
        rev: state.rev,
        words: state.words.length
      });
      return;
    }
    if(url.pathname === '/state' && req.method === 'GET'){
      const since = Number(url.searchParams.get('since') || 0);
      if(since && since === state.rev){
        json(res, 200, { rev: state.rev, updatedAt: state.updatedAt });
        return;
      }
      json(res, 200, { rev: state.rev, updatedAt: state.updatedAt, words: state.words, points: state.points });
      return;
    }
    if(url.pathname === '/state' && req.method === 'POST'){
      const body = await readBody(req);
      if(!Array.isArray(body.words)){ json(res, 400, { error:'bad-request', message:'words 必须是数组' }); return; }
      const words = body.words.slice(0, MAX_STATE_WORDS).map(cleanWord).filter(Boolean);
      const baseRev = Number(body.baseRev) || 0;
      if(baseRev !== state.rev){
        json(res, 409, { error:'conflict', rev: state.rev, updatedAt: state.updatedAt, words: state.words, points: state.points });
        return;
      }
      state.words = words;
      state.points = cleanPoints(body.points);
      state.rev += 1;
      state.updatedAt = Date.now();
      persistState();
      json(res, 200, { rev: state.rev, updatedAt: state.updatedAt });
      return;
    }
    if(url.pathname === '/key' && req.method === 'POST'){
      const body = await readBody(req);
      const key = String(body.key || '').trim();
      if(key && !/^sk-[A-Za-z0-9._\-]{8,}$/.test(key)){
        json(res, 400, { error:'bad-request', message:'API Key 格式不正确' });
        return;
      }
      state.key = key;
      persistState();
      json(res, 200, { ok: true, hasKey: !!key });
      return;
    }

    /* ---- 大模型校验 ---- */
    if(url.pathname === '/lookup' && req.method === 'POST'){
      // 手机端可以不填 Key：直接复用电脑上保存的那一个
      const key = (req.headers['authorization']||'').replace(/^Bearer\s+/i,'').trim() || state.key;
      if(!key){ json(res, 401, { error:'no-key', message:'尚未设置 API Key，请在【设置】里填写' }); return; }
      const body = await readBody(req);
      const words = Array.isArray(body.words)
        ? body.words.map(w=>String(w).trim()).filter(w=>w && w.length<=80).slice(0,MAX_WORDS)
        : [];
      if(!words.length){ json(res, 400, { error:'bad-request', message:'缺少有效单词' }); return; }
      const raw = await callDeepSeek(key, words);
      json(res, 200, { results: align(words, raw) });
      return;
    }

    /* ---- 静态页（页面的 HEAD 用于前端探测服务是否在运行） ---- */
    if(req.method === 'GET' || req.method === 'HEAD'){
      let p = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.normalize(path.join(ROOT, p));
      // 必须加上 path.sep：否则 ROOT 为 ...\word-practice 时，
      // 兄弟目录 ...\word-practice-evil 也会被误判为"在目录内"
      if(file !== ROOT && !file.startsWith(ROOT + path.sep)){ json(res, 403, {error:'forbidden'}); return; }
      // 不对外提供隐藏文件（.git 等）和共享数据 / Key
      const rel = path.relative(ROOT, file);
      if(rel.split(path.sep).some(seg=>seg.startsWith('.'))){ json(res, 404, { error:'not-found' }); return; }
      if(/^data\.json(\.tmp)?$/i.test(path.basename(file))){ json(res, 404, { error:'not-found' }); return; }
      if(fs.existsSync(file) && fs.statSync(file).isFile()){ sendFile(req, res, file); return; }
      json(res, 404, { error:'not-found' });
      return;
    }
    json(res, 405, { error:'method' });
  }catch(e){
    if(e.tooLarge) json(res, 413, { error:'too-large', message:'请求体超过 2MB 上限' });
    else if(e.dsStatus === 401) json(res, 401, { error:'auth', message:'API Key 无效（DeepSeek 拒绝）' });
    else if(e.dsStatus === 402 || e.dsStatus === 429) json(res, 429, { error:'quota', message:'DeepSeek 额度不足或请求过频（'+e.dsStatus+'）' });
    else if(e.dsStatus) json(res, 502, { error:'upstream', message:'DeepSeek 返回 '+e.dsStatus });
    else json(res, 500, { error:'internal', message:'服务内部错误：'+e.message });
  }
});

/* 超时兜底：防止连接被长时间占用（slowloris 一类）
   requestTimeout 给足 120s，避免大批量调用 DeepSeek 时被误杀 */
server.headersTimeout  = 20000;
server.requestTimeout  = 120000;
server.maxHeadersCount = 100;

(async ()=>{
  try{ buildAllowlist(await detectPrimaryIPv4()); }catch(e){}
  server.listen(PORT, HOST, ()=>{
    console.log('背单词练习运行中:  http://127.0.0.1:'+PORT);
    if(LAN_IPS.length){
      console.log('手机（同一 Wi-Fi）扫码/访问:');
      for(const ip of LAN_IPS) console.log('    http://'+ip+':'+PORT+'/');
      console.log('打不开？① Windows 防火墙放行 node（专用网络）② 路由器/校园网关闭了"AP 隔离"');
    }else{
      console.log('未检测到局域网 IP（只有本机能访问）。');
    }
    console.log('DeepSeek 校验服务已就绪（Node '+process.version+'）');
    if(state.key) console.log('已保存 API Key（手机端可直接复用）');
  });
})();
server.on('error', e=>{
  if(e.code==='EADDRINUSE') console.error('端口 '+PORT+' 被占用，可改环境变量 PORT 换端口');
  else console.error(e);
});
