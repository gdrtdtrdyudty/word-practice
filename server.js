/* ============================================================
   背单词练习 · 本地服务
   - 提供静态页面（index.html）
   - POST /lookup : 把一组英文词转发给 DeepSeek，返回 校验+词性+中文
   运行: node server.js   (默认 http://127.0.0.1:8111 )
   无第三方依赖，Node 18+ 自带 fetch。
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8111;
const DS_URL = 'https://api.deepseek.com/chat/completions';
const MAX_WORDS = 120;
const MAX_BODY = 1e6;

/* ---------- 安全策略 ----------
   服务只监听 127.0.0.1，外部机器本就无法连接。这里防的是"本机浏览器"发起的攻击：
   1) Host 校验   → 防 DNS rebinding（恶意域名解析到 127.0.0.1 后访问本服务）
   2) Origin 校验 → 防任意网页用 fetch 调用本机接口
   3) 响应头加固  → nosniff / 禁 framing / 禁 referrer
   4) 目录穿越防护 + 请求体上限 + 超时 */
const ALLOWED_HOSTS = new Set(['127.0.0.1:'+PORT, 'localhost:'+PORT, '[::1]:'+PORT]);
const LOCAL_HOSTNAMES = new Set(['127.0.0.1','localhost','::1','[::1]']);

function hostAllowed(req){
  return ALLOWED_HOSTS.has(String(req.headers.host||'').toLowerCase());
}
function originAllowed(req){
  const o = req.headers.origin;
  if(!o) return true;                 // 无 Origin 头：本机地址栏导航 / curl 等，非跨站
  if(o === 'null') return false;      // file:// 或沙箱 iframe 发来的
  try{
    const u = new URL(o);
    return LOCAL_HOSTNAMES.has(u.hostname.toLowerCase()) && (!u.port || u.port === String(PORT));
  }catch(e){ return false; }
}
/* 所有响应统一附带的加固头 */
const SEC_HEADERS = {
  'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer',
  'Cache-Control':'no-store'
};

/* ---------- 静态文件 ---------- */
const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json','.svg':'image/svg+xml'};
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
  // 解析 JSON（容忍偶尔多出的解释文字）
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
    json(res, 403, { error:'forbidden', message:'仅允许通过 http://127.0.0.1:'+PORT+' 访问' });
    return;
  }
  const url = new URL(req.url, 'http://'+req.headers.host);
  try{
    // API
    if(url.pathname === '/lookup' && req.method === 'POST'){
      const key = (req.headers['authorization']||'').replace(/^Bearer\s+/i,'').trim();
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
    // 静态页（页面的 HEAD 用于前端探测本机服务是否在运行）
    if(req.method === 'GET' || req.method === 'HEAD'){
      let p = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.normalize(path.join(ROOT, p));
      // 必须加上 path.sep：否则 ROOT 为 ...\word-practice 时，
      // 兄弟目录 ...\word-practice-evil 也会被误判为"在目录内"
      if(file !== ROOT && !file.startsWith(ROOT + path.sep)){ json(res, 403, {error:'forbidden'}); return; }
      if(fs.existsSync(file) && fs.statSync(file).isFile()){ sendFile(req, res, file); return; }
      json(res, 404, { error:'not-found' });
      return;
    }
    json(res, 405, { error:'method' });
  }catch(e){
    if(e.tooLarge) json(res, 413, { error:'too-large', message:'请求体超过 1MB 上限' });
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

server.listen(PORT, '127.0.0.1', ()=>{
  console.log('背单词练习运行中:  http://127.0.0.1:'+PORT);
  console.log('DeepSeek 校验服务已就绪（Node '+process.version+'）');
});
server.on('error', e=>{
  if(e.code==='EADDRINUSE') console.error('端口 '+PORT+' 被占用，可改环境变量 PORT 换端口');
  else console.error(e);
});
