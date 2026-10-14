/* UNMADE. — collegamento a Supabase
   Offre al gestionale la stessa interfaccia dell'archivio usato su claude.ai
   (collection → onSnapshot / get / doc → set / update / delete), più immagini e accesso. */
(function(){
  const CFG=window.UNMADE_CONFIG;
  const SB=window.supabase.createClient(CFG.url,CFG.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  const PIXEL='data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const BUCKET='media';

  const newId=()=>{const a='abcdefghijklmnopqrstuvwxyz0123456789',r=new Uint8Array(20);crypto.getRandomValues(r);return [...r].map(x=>a[x%36]).join('')};
  // traduce gli errori di Supabase nei codici che il gestionale già gestisce
  const wrap=e=>{
    const m=(e&&e.message)||'';
    const denied=e&&(e.code==='42501'||e.code==='P0002'||/row-level security|permission denied|not allowed/i.test(m));
    return {code:denied?'invalid_argument':'unavailable',message:m};
  };

  /* ---------- dati, in tempo reale ---------- */
  function createStore(){
    const cache={},loaded={},loading={},listeners={};
    const snapOf=c=>{const m=cache[c]||new Map();const docs=[...m].map(([id,d])=>({id,exists:true,data:()=>d}));
      return {docs,size:docs.length,empty:!docs.length,docChanges:()=>[],metadata:{fromCache:false,hasPendingWrites:false}}};
    const emit=c=>{if(!loaded[c])return;(listeners[c]||[]).forEach(fn=>{try{fn(snapOf(c))}catch(err){console.error(err)}})};
    const put=(c,id,d)=>{(cache[c]=cache[c]||new Map()).set(id,d)};
    async function fetchColl(c){
      const all=[];
      for(let from=0;;from+=1000){
        const {data,error}=await SB.from('docs').select('id,data').eq('coll',c).range(from,from+999);
        if(error)throw wrap(error);
        all.push(...data);if(data.length<1000)break;
      }
      return all;
    }
    function load(c){
      if(loading[c])return loading[c];
      loading[c]=fetchColl(c).then(rows=>{const m=new Map();rows.forEach(r=>m.set(r.id,r.data));cache[c]=m;loaded[c]=true;emit(c)})
        .finally(()=>{loading[c]=null});
      return loading[c];
    }
    const resync=()=>Object.keys(loaded).forEach(c=>load(c).catch(()=>{}));
    SB.channel('unmade-docs')
      .on('postgres_changes',{event:'*',schema:'public',table:'docs'},p=>{
        const row=p.eventType==='DELETE'?p.old:p.new;if(!row||!row.coll)return;
        if(p.eventType==='DELETE')cache[row.coll]&&cache[row.coll].delete(row.id);else put(row.coll,row.id,row.data);
        emit(row.coll);
      })
      .subscribe(status=>{if(status==='SUBSCRIBED')resync()});
    // telefono che si risveglia o rete che torna: riallinea i dati
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')resync()});
    window.addEventListener('online',resync);

    function collection(c){
      return {
        path:c,
        onSnapshot(next,err){
          (listeners[c]=listeners[c]||new Set()).add(next);
          if(loaded[c])setTimeout(()=>next(snapOf(c)),0);else load(c).catch(e=>err&&err(e));
          return ()=>listeners[c].delete(next);
        },
        async get(){const rows=await fetchColl(c);return {docs:rows.map(r=>({id:r.id,exists:true,data:()=>r.data}))}},
        doc(id){
          id=id||newId();
          return {id,path:c+'/'+id,
            async set(d){
              const {error}=await SB.from('docs').upsert({coll:c,id,data:d,updated_at:new Date().toISOString()});
              if(error)throw wrap(error);put(c,id,d);emit(c);
            },
            async update(patch){
              const {data,error}=await SB.rpc('doc_update',{p_coll:c,p_id:id,p_patch:patch});
              if(error)throw wrap(error);put(c,id,data);emit(c);
            },
            async delete(){
              const {error}=await SB.from('docs').delete().eq('coll',c).eq('id',id);
              if(error)throw wrap(error);cache[c]&&cache[c].delete(id);emit(c);
            }};
        }
      };
    }
    return {collection};
  }

  /* ---------- immagini private: indirizzi firmati, validi 24 ore ---------- */
  const signed={},pending=new Set();let flushT=null,onImages=()=>{};
  function blobSrc(id){
    if(!id)return PIXEL;
    const s=signed[id];if(s&&s.exp>Date.now())return s.url;
    pending.add(id);clearTimeout(flushT);flushT=setTimeout(flushSigned,30);
    return PIXEL;
  }
  async function flushSigned(){
    const ids=[...pending];pending.clear();if(!ids.length)return;
    const {data,error}=await SB.storage.from(BUCKET).createSignedUrls(ids,86400);
    if(error){ids.forEach(id=>signed[id]={url:PIXEL,exp:Date.now()+60000});return}
    let any=false;
    (data||[]).forEach((d,i)=>{const id=d.path||ids[i];
      if(d.signedUrl){signed[id]={url:d.signedUrl,exp:Date.now()+23*3600e3};any=true}
      else signed[id]={url:PIXEL,exp:Date.now()+60000};});
    if(any)onImages();
  }
  const assets={
    async upload(blob,opts){
      const type=(opts&&opts.type)||blob.type||'image/jpeg';
      const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}[type];
      if(!ext)throw {code:'unsupported_type',message:type};
      if(blob.size>20*1024*1024)throw {code:'too_large',message:'max 20 MB'};
      const id=newId()+'.'+ext;
      const {error}=await SB.storage.from(BUCKET).upload(id,blob,{contentType:type,upsert:false});
      if(error)throw {code:/size|large/i.test(error.message)?'too_large':/mime|type/i.test(error.message)?'unsupported_type':'upstream_error',message:error.message};
      const url=URL.createObjectURL(blob);signed[id]={url,exp:Date.now()+23*3600e3};
      return {id,url,sizeBytes:blob.size,contentType:type};
    },
    async delete(id){const {error}=await SB.storage.from(BUCKET).remove([id]);if(error)throw {code:'upstream_error',message:error.message};delete signed[id];return {deleted:true}},
    async list(){return {assets:[],usage:{}}}
  };

  /* ---------- accesso ---------- */
  async function signIn(login,password){
    let email=login.trim();
    if(!email.includes('@')){
      const {data,error}=await SB.rpc('login_email',{p_username:email});
      if(error)return {error:'network'};
      if(!data)return {error:'wrong'};
      email=data;
    }
    const {error}=await SB.auth.signInWithPassword({email,password});
    if(error)return {error:/invalid|credentials/i.test(error.message)?'wrong':'network'};
    return {ok:true};
  }
  async function session(){
    const {data}=await SB.auth.getSession();
    const s=data&&data.session;if(!s)return null;
    const {data:prof,error}=await SB.from('profiles').select('username,role').eq('user_id',s.user.id).maybeSingle();
    if(error)return {user:s.user,profile:null,error:'network'};
    return {user:s.user,profile:prof};
  }
  async function signOut(){await SB.auth.signOut()}
  async function changePassword(pw){
    const {error}=await SB.auth.updateUser({password:pw});
    if(!error)return {ok:true};
    const m=error.message||'',c=error.code||'';
    if(c==='same_password'||/different from the old/i.test(m))return {error:'same'};
    if(c==='weak_password'||/weak|at least|characters/i.test(m))return {error:'weak'};
    if(c==='reauthentication_needed'||/reauth/i.test(m))return {error:'reauth'};
    return {error:'network'};
  }

  window.UNMADE_BACKEND={createStore,assets,blobSrc,signIn,session,signOut,changePassword,onImages:fn=>{onImages=fn},client:SB};
})();
