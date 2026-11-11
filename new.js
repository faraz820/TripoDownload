/**
 * tripo3d_model_downloader.js  v12
 * ─────────────────────────────────────────────────────────────────────────────
 * Works on /3d-model/ AND /workspace/generate/ pages.
 *
 * v12:
 *  - Detects real file format (GLB, glTF, gzip, zip, FBX, OBJ, PLY, USD)
 *    and saves with the right extension instead of .bin
 *  - gzip-compressed downloads are decompressed automatically
 *  - Picker lists tripo_pbr_model files first and pre-selects one
 * v11:
 *  - Path A searches provides, setupState, exposed, props AND Pinia for Three scenes
 *  - Path A handles quantized / Uint16 geometry correctly
 *  - URL matching uses the full chain of parent IDs (project/workspace/task)
 *  - If the target model can't be identified, you're asked to pick
 *  - Meshopt GLBs decoded natively → lossless clean GLB
 */

(async function tripoDownload() {
  console.log('[tripo] v12 — starting…');

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const pageUuid = (location.pathname.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  ) || [])[1] || null;
  console.log('[tripo] Page UUID:', pageUuid || '(none)');

  // ═══════════════════════════════════════════════════════════════════════════
  //  Path A: extract the model currently shown in the viewer
  // ═══════════════════════════════════════════════════════════════════════════
  const sceneResult = await trySceneExtraction();
  if (sceneResult) return sceneResult;

  console.log('[tripo] Path A failed — trying Path B (URL capture)…');

  // ═══════════════════════════════════════════════════════════════════════════
  //  Path B: find URL, download, detect format / decompress, save
  // ═══════════════════════════════════════════════════════════════════════════
  const url = await findModelUrl();
  if (!url) { console.error('[tripo] ❌ No model URL selected/found.'); return; }

  await downloadAndProcess(url);

  // ─────────────────────────────────────────────────────────────────────────
  //  PATH A: Scene extraction
  // ─────────────────────────────────────────────────────────────────────────
  async function trySceneExtraction() {
    try {
      const appEl = document.querySelector('#__nuxt') || document.querySelector('[data-v-app]');
      const vueApp = appEl?.__vue_app__;
      if (!vueApp) { console.log('[tripo] Path A: no Vue app found'); return null; }

      const candidates = [];
      const seenObj = new WeakSet();

      const findRenderer = holder => {
        if (!holder || typeof holder !== 'object') return null;
        for (const k of Reflect.ownKeys(holder)) {
          try {
            let v = holder[k]; v = v?.__v_isRef ? v.value : v;
            for (const r of [v, v?.instance?.value, v?.instance, v?.value]) {
              if (r?.domElement instanceof HTMLCanvasElement) return r;
            }
          } catch (_) {}
        }
        return null;
      };
      const addScene = (s, holder) => {
        if (candidates.some(c => c.scene === s)) return;
        candidates.push({ scene: s, renderer: findRenderer(holder) });
      };
      const scan = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 4) return;
        try { if (obj instanceof Node || obj === window) return; } catch (_) { return; }
        if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return;
        if (seenObj.has(obj)) return;
        try { seenObj.add(obj); } catch (_) { return; }
        if (obj.isScene) { addScene(obj, null); return; }
        if (obj.isObject3D) return;
        let keys; try { keys = Reflect.ownKeys(obj); } catch (_) { return; }
        for (const k of keys) {
          let v; try { v = obj[k]; } catch (_) { continue; }
          if (!v || typeof v !== 'object') continue;
          const inner = v.__v_isRef ? v.value : v;
          if (inner?.isScene) addScene(inner, obj);
          else scan(inner, depth + 1);
        }
      };

      const visited = new WeakSet();
      let compCount = 0;
      const walk = (vn, d = 0) => {
        if (!vn || d > 60) return;
        const c = vn.component;
        if (c && !visited.has(c)) {
          visited.add(c); compCount++;
          for (const part of [c.provides, c.setupState, c.exposed, c.props, c.data]) {
            try { scan(part, 0); } catch (_) {}
          }
          walk(c.subTree, d + 1);
        }
        const kids = vn.dynamicChildren || vn.children;
        if (Array.isArray(kids)) for (const ch of kids) if (ch && typeof ch === 'object') walk(ch, d);
      };
      walk(vueApp._container?._vnode);
      try { for (const [, store] of vueApp.config.globalProperties.$pinia?._s || []) scan(store, 0); } catch (_) {}

      console.log(`[tripo] Path A: ${compCount} components, ${candidates.length} scene(s)`);
      if (!candidates.length) return null;

      const visibleArea = el => {
        if (!el?.isConnected) return 0;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) return 0;
        const b = el.getBoundingClientRect();
        const w = Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0));
        const h = Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
        return w * h;
      };
      for (const c of candidates) {
        c.area = visibleArea(c.renderer?.domElement);
        c.verts = visibleMeshes(c.scene).reduce((s, m) => s + m.geometry.attributes.position.count, 0);
      }
      candidates.sort((a, b) => (b.area - a.area) || (b.verts - a.verts));
      console.log('[tripo] Scenes (canvas area / visible verts):',
        candidates.map(c => `${Math.round(c.area)} / ${c.verts}`));

      const best = candidates.find(c => c.verts > 0);
      if (!best) return null;
      return await buildGlbFromScene(best.scene);
    } catch (err) {
      console.log('[tripo] Path A error:', err.message);
      return null;
    }
  }

  function visibleMeshes(scene) {
    const shown = o => { for (; o; o = o.parent) if (o.visible === false) return false; return true; };
    const out = [];
    scene.traverse?.(o => {
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (o.isMesh && o.geometry?.attributes?.position && mat?.visible !== false && shown(o)) out.push(o);
    });
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Build GLB from a Three.js Scene (largest visible mesh)
  // ─────────────────────────────────────────────────────────────────────────
  async function buildGlbFromScene(scene) {
    scene.updateMatrixWorld?.(true);
    const meshes = visibleMeshes(scene);
    if (!meshes.length) return null;
    const modelMesh = meshes.reduce((best, m) =>
      m.geometry.attributes.position.count > best.geometry.attributes.position.count ? m : best);

    const geo = modelMesh.geometry;
    const mat = Array.isArray(modelMesh.material) ? modelMesh.material[0] : modelMesh.material;
    const posAttr = geo.attributes.position, uvAttr = geo.attributes.uv;
    const vCount = posAttr.count;
    console.log(`[tripo] Mesh: "${modelMesh.name}" — ${vCount} verts (${meshes.length} visible meshes)`);

    // Positions → float32, with world transform baked in (handles quantized data)
    const e = modelMesh.matrixWorld.elements;
    const positions = new Float32Array(vCount * 3);
    for (let i = 0; i < vCount; i++) {
      const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
      positions[i*3]   = e[0]*x + e[4]*y + e[8]*z  + e[12];
      positions[i*3+1] = e[1]*x + e[5]*y + e[9]*z  + e[13];
      positions[i*3+2] = e[2]*x + e[6]*y + e[10]*z + e[14];
    }

    // UVs → float32; only flip when texture uses flipY=true (glTF-loaded textures don't)
    const tex = mat?.map;
    let uvs = null;
    if (uvAttr) {
      const flip = tex && tex.flipY !== false;
      uvs = new Float32Array(uvAttr.count * 2);
      for (let i = 0; i < uvAttr.count; i++) {
        uvs[i*2] = uvAttr.getX(i);
        const v = uvAttr.getY(i);
        uvs[i*2+1] = flip ? 1 - v : v;
      }
    }

    // Indices → always uint32 (matches componentType 5125)
    const indices = geo.index ? Uint32Array.from(geo.index.array) : null;

    let texPNG = null;
    const texImg = tex?.image;
    if (texImg) {
      const c = document.createElement('canvas');
      c.width = texImg.width ?? texImg.naturalWidth ?? 1024;
      c.height = texImg.height ?? texImg.naturalHeight ?? 1024;
      c.getContext('2d').drawImage(texImg, 0, 0);
      texPNG = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer());
      console.log(`[tripo] Texture: ${c.width}×${c.height}`);
    }

    const align4 = n => Math.ceil(n / 4) * 4;
    const posBytes = positions.byteLength;
    const uvBytes  = uvs     ? align4(uvs.byteLength)     : 0;
    const idxBytes = indices ? align4(indices.byteLength) : 0;
    const texBytes = texPNG  ? align4(texPNG.byteLength)  : 0;
    const uvOff  = align4(posBytes);
    const idxOff = uvOff + uvBytes;
    const texOff = idxOff + idxBytes;
    const totalBin = align4(texOff + texBytes);

    let minP = [Infinity,Infinity,Infinity], maxP = [-Infinity,-Infinity,-Infinity];
    for (let i = 0; i < positions.length; i += 3)
      for (let j = 0; j < 3; j++) { minP[j] = Math.min(minP[j], positions[i+j]); maxP[j] = Math.max(maxP[j], positions[i+j]); }

    const acc = [], bv = [], pa = {};
    bv.push({ buffer:0, byteOffset:0, byteLength:posBytes, target:34962 });
    acc.push({ bufferView:0, byteOffset:0, componentType:5126, count:vCount, type:'VEC3', min:minP, max:maxP });
    pa.POSITION = 0;
    if (uvs) { const b=bv.length; bv.push({buffer:0,byteOffset:uvOff,byteLength:uvs.byteLength,target:34962}); pa.TEXCOORD_0=acc.length; acc.push({bufferView:b,byteOffset:0,componentType:5126,count:uvs.length/2,type:'VEC2'}); }
    let idxAcc = null;
    if (indices) { const b=bv.length; bv.push({buffer:0,byteOffset:idxOff,byteLength:indices.byteLength,target:34963}); idxAcc=acc.length; acc.push({bufferView:b,byteOffset:0,componentType:5125,count:indices.length,type:'SCALAR'}); }
    let imgBv = null;
    if (texPNG) { imgBv=bv.length; bv.push({buffer:0,byteOffset:texOff,byteLength:texPNG.byteLength}); }

    const prim = { attributes: pa };
    if (idxAcc !== null) prim.indices = idxAcc;
    if (imgBv !== null) prim.material = 0;

    const gltf = {
      asset:{version:'2.0',generator:'tripo-extractor-v12'}, scene:0,
      scenes:[{name:'Scene',nodes:[0]}], nodes:[{name:modelMesh.name||'tripo_model',mesh:0}],
      meshes:[{name:'tripo_mesh',primitives:[prim]}], accessors:acc, bufferViews:bv, buffers:[{byteLength:totalBin}],
      ...(imgBv!==null?{materials:[{name:'tripo_mat',pbrMetallicRoughness:{baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:.5},doubleSided:true}],textures:[{source:0}],images:[{mimeType:'image/png',bufferView:imgBv}]}:{})
    };

    const jsonEnc = new TextEncoder().encode(JSON.stringify(gltf));
    const jsonPad = align4(jsonEnc.length);
    const totalSz = 12 + 8 + jsonPad + 8 + totalBin;
    const glb = new ArrayBuffer(totalSz);
    const dv = new DataView(glb), buf = new Uint8Array(glb);
    let o = 0;
    dv.setUint32(o,0x46546C67,true);o+=4; dv.setUint32(o,2,true);o+=4; dv.setUint32(o,totalSz,true);o+=4;
    dv.setUint32(o,jsonPad,true);o+=4; dv.setUint32(o,0x4E4F534A,true);o+=4;
    buf.set(jsonEnc,o); buf.fill(0x20,o+jsonEnc.length,o+jsonPad); o+=jsonPad;
    dv.setUint32(o,totalBin,true);o+=4; dv.setUint32(o,0x004E4942,true);o+=4;
    const bs=o;
    buf.set(new Uint8Array(positions.buffer),bs);
    if(uvs) buf.set(new Uint8Array(uvs.buffer),bs+uvOff);
    if(indices) buf.set(new Uint8Array(indices.buffer),bs+idxOff);
    if(texPNG) buf.set(texPNG,bs+texOff);

    saveFile(new Blob([glb], {type:'model/gltf-binary'}), 'glb');
    console.log(`[tripo] ✓ Clean GLB from viewer: ${(totalSz/1048576).toFixed(2)} MB, ${vCount} verts`);
    return { vertices: vCount };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  DOWNLOAD + detect format / decompress
  // ─────────────────────────────────────────────────────────────────────────
  async function downloadAndProcess(url) {
    console.log('[tripo] Downloading:', url.substring(0, 160));
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    console.log('[tripo] Content-Type:', resp.headers.get('content-type'));
    await processBuffer(await resp.arrayBuffer(), url);
  }

  async function processBuffer(arrayBuf, url) {
    const bytes = new Uint8Array(arrayBuf);
    console.log(`[tripo] ${bytes.length} bytes, first 16: ${[...bytes.slice(0,16)].map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
    const head = new TextDecoder().decode(bytes.slice(0, 256)).trimStart();
    const urlExt = (url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase();

    // ── GLB ──
    if (bytes[0]===0x67 && bytes[1]===0x6C && bytes[2]===0x54 && bytes[3]===0x46) {
      const isMeshopt = checkMeshopt(arrayBuf);
      console.log(`[tripo] GLB, meshopt compressed: ${isMeshopt}`);
      if (!isMeshopt) { saveFile(new Blob([arrayBuf], {type:'model/gltf-binary'}), 'glb'); return; }

      let decoder = (typeof MeshoptDecoder !== 'undefined') ? MeshoptDecoder : null;
      if (!decoder) {
        console.log('[tripo] Loading MeshoptDecoder from CDN…');
        try { decoder = await loadMeshoptFromCDN(); }
        catch (err) { console.warn('[tripo] Could not load MeshoptDecoder:', err.message); }
      }
      if (decoder) {
        try {
          const clean = await decodeMeshoptGlb(arrayBuf, decoder);
          saveFile(new Blob([clean], {type:'model/gltf-binary'}), 'glb');
          console.log('[tripo] ✓ Meshopt decoded — clean GLB saved');
          return;
        } catch (err) { console.error('[tripo] Decompression failed:', err.message); }
      }
      console.warn('[tripo] ⚠ Saving raw meshopt GLB.');
      saveFile(new Blob([arrayBuf], {type:'model/gltf-binary'}), 'glb');
      return;
    }

    // ── gzip → decompress and re-check ──
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      console.log('[tripo] gzip detected — decompressing…');
      const stream = new Blob([arrayBuf]).stream().pipeThrough(new DecompressionStream('gzip'));
      return processBuffer(await new Response(stream).arrayBuffer(), url.replace(/\.gz(?=\?|$)/i, ''));
    }

    // ── expired link / error page ──
    if (head.startsWith('<')) {
      console.error('[tripo] ❌ Got an HTML page, not a model — URL probably expired. Reload and retry.');
      return;
    }

    // ── other formats ──
    let ext = null;
    if (bytes[0] === 0x50 && bytes[1] === 0x4B)                       ext = urlExt === 'usdz' ? 'usdz' : 'zip';
    else if (head.startsWith('Kaydara FBX Binary') || head.startsWith('; FBX')) ext = 'fbx';
    else if (head.startsWith('ply'))                                  ext = 'ply';
    else if (head.startsWith('PXR-USDC'))                             ext = 'usdc';
    else if (head.startsWith('#usda'))                                ext = 'usda';
    else if (head.startsWith('{') && head.includes('"asset"'))        ext = 'gltf';
    else if (/^(mtllib|usemtl|v |vn |vt |o |g |f )/m.test(head))      ext = 'obj';
    else if (urlExt && urlExt !== 'bin')                              ext = urlExt;

    if (ext) {
      console.log(`[tripo] Detected format: .${ext}`);
      if (ext === 'zip') console.warn('[tripo] It is a zip — extract it, then import the .glb/.fbx/.obj inside.');
      if (ext === 'gltf') console.warn('[tripo] .gltf usually needs a separate .bin + textures — this alone may import without geometry.');
      saveFile(new Blob([arrayBuf]), ext);
      return;
    }

    console.warn('[tripo] ⚠ Unknown format — not a model file. You probably picked the wrong entry; rerun and choose one named tripo_pbr_model….');
    saveFile(new Blob([arrayBuf]), 'bin');
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Native meshopt → plain GLB (lossless: keeps all meshes/materials/textures)
  // ─────────────────────────────────────────────────────────────────────────
  async function decodeMeshoptGlb(arrayBuf, decoder) {
    if (decoder.ready) await decoder.ready;
    const EXT = ['EXT_meshopt_compression', 'KHR_meshopt_compression'];
    const dv = new DataView(arrayBuf);
    const jsonLen = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuf, 20, jsonLen)));

    const binHdr = 20 + jsonLen;
    let bin = null;
    if (binHdr + 8 <= arrayBuf.byteLength && dv.getUint32(binHdr + 4, true) === 0x004E4942)
      bin = new Uint8Array(arrayBuf, binHdr + 8, dv.getUint32(binHdr, true));
    const bufData = i => {
      if (i === 0 && bin && json.buffers?.[0]?.uri === undefined) return bin;
      throw new Error(`buffer ${i} has no embedded data`);
    };

    const views = json.bufferViews || [];
    const chunks = views.map(bv => {
      const extName = EXT.find(n => bv.extensions?.[n]);
      if (!extName) {
        const off = bv.byteOffset || 0;
        return bufData(bv.buffer).subarray(off, off + bv.byteLength);
      }
      const ext = bv.extensions[extName];
      const off = ext.byteOffset || 0;
      const src = bufData(ext.buffer).subarray(off, off + ext.byteLength);
      const out = new Uint8Array(ext.count * ext.byteStride);
      decoder.decodeGltfBuffer(out, ext.count, ext.byteStride, src, ext.mode, ext.filter || 'NONE');
      delete bv.extensions[extName];
      if (!Object.keys(bv.extensions).length) delete bv.extensions;
      return out;
    });

    const align4 = n => (n + 3) & ~3;
    let total = 0;
    const offs = chunks.map(c => { const o = total; total = align4(total + c.byteLength); return o; });
    const newBin = new Uint8Array(total);
    chunks.forEach((c, i) => {
      newBin.set(c, offs[i]);
      views[i].buffer = 0;
      views[i].byteOffset = offs[i];
      views[i].byteLength = c.byteLength;
    });
    json.buffers = [{ byteLength: total }];
    for (const key of ['extensionsUsed', 'extensionsRequired']) {
      if (!json[key]) continue;
      json[key] = json[key].filter(n => !EXT.includes(n));
      if (!json[key].length) delete json[key];
    }
    if (json.extensionsUsed?.length) console.log('[tripo] Remaining extensions:', json.extensionsUsed.join(', '));

    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = align4(jsonBytes.length);
    const size = 12 + 8 + jsonPad + 8 + total;
    const out = new ArrayBuffer(size);
    const odv = new DataView(out), ob = new Uint8Array(out);
    odv.setUint32(0, 0x46546C67, true); odv.setUint32(4, 2, true); odv.setUint32(8, size, true);
    odv.setUint32(12, jsonPad, true); odv.setUint32(16, 0x4E4F534A, true);
    ob.set(jsonBytes, 20); ob.fill(0x20, 20 + jsonBytes.length, 20 + jsonPad);
    odv.setUint32(20 + jsonPad, total, true); odv.setUint32(24 + jsonPad, 0x004E4942, true);
    ob.set(newBin, 28 + jsonPad);
    return out;
  }

  function checkMeshopt(arrayBuf) {
    try {
      const dv = new DataView(arrayBuf);
      const jsonLen = dv.getUint32(12, true);
      if (dv.getUint32(16, true) !== 0x4E4F534A) return false;
      const s = new TextDecoder().decode(new Uint8Array(arrayBuf, 20, jsonLen));
      return s.includes('EXT_meshopt_compression') || s.includes('KHR_meshopt_compression');
    } catch (_) { return false; }
  }

  async function loadMeshoptFromCDN() {
    for (const cdnUrl of [
      'https://cdn.jsdelivr.net/npm/meshoptimizer@0.21.0/meshopt_decoder.module.js',
      'https://unpkg.com/meshoptimizer@0.21.0/meshopt_decoder.module.js'
    ]) {
      try {
        const mod = await import(cdnUrl);
        const dec = mod.MeshoptDecoder || mod.default;
        if (dec) { if (dec.ready) await dec.ready; console.log('[tripo] MeshoptDecoder loaded'); return dec; }
      } catch (_) {}
    }
    throw new Error('all CDNs failed');
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Find the currently selected task (pages without a task UUID in the URL)
  // ─────────────────────────────────────────────────────────────────────────
  function findActiveTaskId() {
    const KEY = /(current|active|selected|focus)\w*(task|model|id)/i;
    try {
      const app = (document.querySelector('#__nuxt') || document.querySelector('[data-v-app]'))?.__vue_app__;
      for (const [id, store] of app?.config?.globalProperties?.$pinia?._s || []) {
        const st = store.$state || {};
        for (const k of Object.keys(st)) {
          if (!KEY.test(k)) continue;
          const v = st[k]?.value ?? st[k];
          const c = typeof v === 'string' ? v : (v?.task_id || v?.taskId || v?.id || v?.uuid);
          if (typeof c === 'string' && UUID_RE.test(c)) {
            console.log(`[tripo] Active task from pinia[${id}].${k}: ${c}`);
            return c;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  PATH B: URL Capture
  // ─────────────────────────────────────────────────────────────────────────
  async function findModelUrl() {
    const GLB_HINTS = ['.glb', '.gltf', 'pbr_model', 'base_model'];
    const ASSET_HOSTS = ['tripo-data.', 'data.tripo3d.', '.cloudfront.net'];
    const MODEL_KEYS = ['model_url','glb_url','file_url','model','asset','src','url',
      'pbr_model','base_model','download_url','export_url','result_url','output_url','data_url','mesh_url'];
    const NON_ASSET = /\.(png|jpg|jpeg|webp|gif|mp4|webm|svg|json|js|css|woff|ttf|ico)(\?|#|$)/i;
    const SKIP_HOSTS = ['fonts.googleapis','cdn.jsdelivr','google-analytics','googletagmanager','sentry.io','hotjar.com','intercom','segment.','unpkg.com'];
    const ID_KEY = /(^id$|_id$|Id$|uuid)/;

    function isModelUrl(u) {
      if (!u || typeof u !== 'string' || !u.startsWith('http')) return false;
      if (NON_ASSET.test(u)) return false;
      const l = u.toLowerCase();
      if (SKIP_HOSTS.some(h => l.includes(h))) return false;
      return GLB_HINTS.some(h => l.includes(h)) || ASSET_HOSTS.some(h => l.includes(h));
    }
    function couldBeAsset(u) {
      if (!u || typeof u !== 'string' || !u.startsWith('http')) return false;
      if (NON_ASSET.test(u)) return false;
      const l = u.toLowerCase();
      if (SKIP_HOSTS.some(h => l.includes(h))) return false;
      if (ASSET_HOSTS.some(h => l.includes(h))) return true;
      return l.includes('tripo') && (l.includes('model') || l.includes('mesh'));
    }

    const found = [];
    function addUrl(url, source, chain = []) {
      if (found.some(f => f.url === url)) return;
      found.push({ url, source, chain });
      const tag = chain[0] ? ` [${chain[0].substring(0,8)}]` : '';
      console.log(`[tripo] URL: ${url.substring(0,100)}… (${source})${tag}`);
    }

    const seen = new WeakSet();
    function isSafe(v) {
      if (v === null || typeof v !== 'object') return false;
      if (v === window || v === document) return false;
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
      try { if (v instanceof Node) return false; } catch (_) {}
      return true;
    }

    // chain = every UUID-valued id field on this object and all its ancestors
    function scanObj(obj, depth, source, ctx = []) {
      if (depth > 25 || !isSafe(obj)) return;
      if (seen.has(obj)) return;
      try { seen.add(obj); } catch (_) { return; }
      if (obj.__v_isRef && obj.value !== undefined) { scanObj(obj.value, depth + 1, source, ctx); return; }

      const local = [];
      let keys; try { keys = Object.keys(obj); } catch (_) { return; }
      if (!Array.isArray(obj)) for (const k of keys) {
        if (!ID_KEY.test(k)) continue;
        try { const v = obj[k]; if (typeof v === 'string' && UUID_RE.test(v)) local.push(v.toLowerCase()); } catch (_) {}
      }
      const chain = local.length ? [...local, ...ctx] : ctx;

      for (const key of keys) {
        if (['document','window','parent','top','frames','__proto__'].includes(key)) continue;
        try {
          const val = obj[key];
          if (typeof val === 'string' && val.startsWith('http')) {
            if (isModelUrl(val)) addUrl(val, `${source}[${key}]`, chain);
            else if (MODEL_KEYS.some(k => key.toLowerCase().includes(k)) && couldBeAsset(val)) addUrl(val, `${source}[${key}]`, chain);
          } else if (isSafe(val)) {
            scanObj(val, depth + 1, source, chain);
          }
        } catch (_) {}
      }
    }

    // Performance entries — newest first
    try {
      const entries = performance.getEntriesByType('resource').slice().sort((a, b) => b.responseEnd - a.responseEnd);
      for (const e of entries) if (isModelUrl(e.name)) {
        const m = e.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        addUrl(e.name, 'perf', m ? [m[1].toLowerCase()] : []);
      }
    } catch (_) {}

    // Pinia + Vue tree
    try {
      const vueApp = (document.querySelector('#__nuxt') || document.querySelector('[data-v-app]'))?.__vue_app__;
      if (vueApp) {
        const pinia = vueApp.config?.globalProperties?.$pinia;
        if (pinia?._s) for (const [id, store] of pinia._s) {
          try { scanObj(store.$state, 0, `pinia[${id}].$state`); } catch (_) {}
          try { scanObj(store, 0, `pinia[${id}]`); } catch (_) {}
        }
        const walkVue = (vn, d, src) => {
          if (!vn || d > 40) return;
          if (vn.component) {
            const inst = vn.component;
            for (const s of ['setupState','exposed','ctx','data','props']) try { inst[s] && scanObj(inst[s], 0, `${src}.${s}`); } catch (_) {}
            try { inst.provides && scanObj(inst.provides, 0, `${src}.provides`); } catch (_) {}
            walkVue(inst.subTree, d + 1, src);
          }
          const kids = vn.dynamicChildren || vn.children;
          if (Array.isArray(kids)) for (const ch of kids) if (ch && typeof ch === 'object') walkVue(ch, d, src);
        };
        try { walkVue(vueApp._container?._vnode, 0, 'vue'); } catch (_) {}
      }
    } catch (_) {}

    for (const key of ['__NUXT__','$nuxt','__nuxt']) try { window[key] && scanObj(window[key], 0, key); } catch (_) {}

    const targetId = pageUuid || findActiveTaskId();
    const tl = targetId?.toLowerCase();
    const matches = f => !!tl && (f.chain.includes(tl) || f.url.toLowerCase().includes(tl));

    // Hook network as last resort
    if (found.length === 0) {
      console.log('[tripo] Hooking network — reload or wait for model…');
      const hookUrl = await new Promise(resolve => {
        const timeout = setTimeout(() => resolve(null), 60000);
        const origFetch = window.fetch;
        window.fetch = function (...args) {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0]);
          if (isModelUrl(url)) { clearTimeout(timeout); window.fetch = origFetch; resolve(url); }
          const result = origFetch.apply(this, args);
          if (url.includes('/api/') || url.includes('tripo3d.ai'))
            result.then(r => r.clone().text().then(t => {
              try { scanObj(JSON.parse(t), 0, 'fetch-resp', tl ? [tl] : []); }
              catch (_) { const m = t.match(/https?:\/\/[^\s"'<>{}]+\.glb[^\s"'<>{}]*/gi); if (m) m.forEach(u => addUrl(u, 'fetch-text')); }
              if (found.length > 0) { clearTimeout(timeout); window.fetch = origFetch; resolve(found[0].url); }
            }).catch(() => {})).catch(() => {});
          return result;
        };
        alert('No model URL found yet.\nListening for network requests.\nReload the page (Ctrl+R) or wait.\n(60s timeout)');
      });
      if (hookUrl) addUrl(hookUrl, 'hook');
    }

    if (found.length === 0) return null;

    const isMain = f => !/point_cloud/i.test(f.source);
    const pick = list => list.find(f => isMain(f) && /pbr_model.*\.glb/i.test(f.url))
                      || list.find(f => isMain(f) && /\.glb/i.test(f.url))
                      || list.find(isMain) || list[0];

    console.log(`\n[tripo] ${found.length} URL(s), target: ${targetId || '(unknown)'}`);
    found.forEach((f, i) => console.log(`  ${i+1}. ${f.url.substring(0,100)}… [${f.chain[0]?.substring(0,8) || '?'}]${matches(f) ? ' ★' : ''}`));

    if (tl) {
      const hits = found.filter(matches);
      const hitTasks = new Set(hits.filter(isMain).map(f => f.chain[0] || f.url));
      if (hits.length && hitTasks.size <= 1) { console.log('[tripo] Matched by ID'); return pick(hits).url; }
      if (hitTasks.size > 1) {
        console.warn(`[tripo] ${hitTasks.size} models belong to ${targetId} — asking you to choose.`);
        return askUser(hits.filter(isMain));
      }
      console.warn(`[tripo] ⚠ No URL belongs to ${targetId} — asking you to choose.`);
    }

    const mains = found.filter(isMain);
    if (mains.length === 1) return mains[0].url;
    return askUser(mains.length ? mains : found);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Let the user pick when the target can't be identified
  // ─────────────────────────────────────────────────────────────────────────
  function askUser(list) {
    const dateOf = u => { const m = u.match(/\/(\d{4})(\d{2})(\d{2})\//); return m ? `${m[1]}-${m[2]}-${m[3]}` : '????-??-??'; };
    const nameOf = u => { try { return decodeURIComponent(u.split('?')[0].split('/').pop()).slice(0, 40); } catch (_) { return '?'; } };
    const isPbr = f => /pbr_model/i.test(nameOf(f.url));
    // Newest first; within the same date, tripo_pbr_model files first
    const sorted = list.slice().sort((a, b) =>
      dateOf(b.url).localeCompare(dateOf(a.url)) || (isPbr(b) - isPbr(a)));
    const lines = sorted.map((f, i) =>
      `${i+1}. ${dateOf(f.url)}  task ${f.chain[0]?.slice(0,8) || '?'}  ${nameOf(f.url)}${isPbr(f) ? '  ◀ model' : ''}`);
    const def = Math.max(0, sorted.findIndex(isPbr)) + 1;
    console.log('[tripo] Choices:\n' + lines.join('\n'));
    const ans = prompt(`Couldn't tell which model is on screen.\nEnter a number (newest first, ◀ = model file):\n\n${lines.join('\n')}`, String(def));
    const n = parseInt(ans, 10);
    if (!n || n < 1 || n > sorted.length) return null;
    return sorted[n - 1].url;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  SAVE FILE
  // ─────────────────────────────────────────────────────────────────────────
  function saveFile(blob, ext) {
    const slug = location.pathname.split('/').filter(Boolean).pop() || 'model';
    const filename = `tripo_${slug.substring(0,60)}.${ext}`;
    const bu = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = bu; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(bu), 10000);
    console.log(`[tripo] ✓ Saved: ${filename} (${(blob.size/1048576).toFixed(2)} MB)`);
  }
})();