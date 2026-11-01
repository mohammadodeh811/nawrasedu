export const SOCIAL_PLATFORMS = {
  instagram: {label:'Instagram',domains:['instagram.com'],icon:'<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="18" cy="6" r="1"/>'},
  facebook: {label:'Facebook',domains:['facebook.com','fb.com'],icon:'<path d="M14 21v-8h3l.5-4H14V7c0-1 .5-2 2-2h2V2h-3c-3 0-5 2-5 5v2H7v4h3v8z"/>'},
  github: {label:'GitHub',domains:['github.com'],icon:'<path d="M9 21v-4c-4 1-4-2-6-3M15 21v-4c0-1-.5-2-1-2 4 0 6-2 6-5 0-2-1-3-2-4 0-1 0-2-.5-3-2 0-3 1-4 1h-3c-1 0-2-1-4-1-.5 1-.5 2-.5 3-1 1-2 2-2 4 0 3 2 5 6 5-.5 0-1 1-1 2"/>'},
  linkedin: {label:'LinkedIn',domains:['linkedin.com'],icon:'<rect x="3" y="9" width="4" height="12"/><circle cx="5" cy="4" r="2"/><path d="M11 21V9h4v2c3-4 6-1 6 3v7h-4v-7c0-3-2-3-2 0v7z"/>'},
  youtube: {label:'YouTube',domains:['youtube.com','youtu.be'],icon:'<rect x="2" y="5" width="20" height="14" rx="4"/><path d="m10 9 6 3-6 3z"/>'},
  tiktok: {label:'TikTok',domains:['tiktok.com'],icon:'<path d="M14 3v13a4 4 0 1 1-4-4M14 3c1 4 3 5 7 5"/>'},
  x: {label:'X',domains:['x.com','twitter.com'],icon:'<path d="m4 3 16 18h-5L4 3h5l11 18M20 3 4 21"/>'},
  website: {label:'Website',domains:[],icon:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>'}
};
export function normalizeSocialUrl(platform, raw) {
  const config = SOCIAL_PLATFORMS[platform];
  if (!config || typeof raw !== 'string' || raw.trim().length > 500) return '';
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || url.hostname.endsWith('.local')) return '';
    if (config.domains.length && !config.domains.some(domain => url.hostname === domain || url.hostname.endsWith('.'+domain))) return '';
    url.hash = '';
    const result = url.href;
    return result.length <= 500 ? result : '';
  } catch { return ''; }
}
export function validateSocialLinks(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid social links.');
  const links = {};
  for (const [platform,raw] of Object.entries(input)) {
    if (!Object.hasOwn(SOCIAL_PLATFORMS,platform)) throw new Error('Unsupported social platform.');
    if (typeof raw !== 'string') throw new Error('Invalid social link.');
    if (!raw.trim()) continue;
    const url = normalizeSocialUrl(platform,raw);
    if (!url) throw new Error(`Use a full HTTPS ${SOCIAL_PLATFORMS[platform].label} link on the correct website.`);
    links[platform] = url;
  }
  return links;
}
export function socialLinksMarkup(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const escape = value => value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const links = Object.entries(SOCIAL_PLATFORMS).map(([key,config]) => {
    const url = normalizeSocialUrl(key,input[key]);
    return url ? `<a class="member-social-circle" href="${escape(url)}" target="_blank" rel="noopener noreferrer" aria-label="${config.label}" title="${config.label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${config.icon}</svg></a>` : '';
  }).join('');
  return links ? `<div class="member-social-links" aria-label="Social links">${links}</div>` : '';
}
