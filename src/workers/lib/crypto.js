async function getKey(env) {
  const raw = new Uint8Array(env.ENCRYPTION_KEY.match(/.{1,2}/g).map(b => parseInt(b, 16)));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(plaintext, env) {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array([...iv, ...new Uint8Array(enc)]);
  return btoa(Array.from(combined).map(b => String.fromCharCode(b)).join(''));
}

export async function decrypt(ciphertext, env) {
  const key = await getKey(env);
  const bytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return new TextDecoder().decode(plain);
}