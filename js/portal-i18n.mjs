export const dictionaries = {
 ja: { title:'スタッフ資料ポータル',readOnly:'スタッフ用・閲覧専用',GENERAL:'一般スタッフ',TECHNICAL:'技術スタッフ',common:'共通資料',performer:'出演者資料',preview:'プレビュー',download:'ダウンロード',latest:'最新版',empty:'資料はまだありません',invalid:'リンクが無効または期限切れです。ARA-TECHに確認してください。',error:'読み込めませんでした。再読み込みしてください。',refresh:'更新',date:'開催日',venue:'会場',time:'本番時刻',timezone:'イベント時間帯',updated:'更新',close:'閉じる',language:'言語',manage:'スタッフ共有',create:'発行',rotate:'再発行',revoke:'失効',expiry:'有効期限',saveExpiry:'期限を保存',active:'有効',inactive:'未発行・失効・期限切れ',copy:'URLコピー',copied:'コピーしました',settings:'時間設定を保存',end:'終了日時（任意）',hint:'終了＋24時間。終了日時なしはイベント翌日23:59。',qrHold:'後日の同じQR再表示は未対応です。発行時のURL・QRを安全に保存してください。再発行すると旧リンクは失効します。',confirmRotate:'このグレードの旧URLとセッションを失効し、再発行しますか？',confirmRevoke:'このグレードのリンクを失効しますか？',content:'共通資料に置く原本は、主催者またはARA-TECHがスタッフ共有可能と判断した資料です。',original:'原本資料の内容・言語はそのまま表示します。',localTime:'入力日時はイベント時間帯です。',qrLong:'URLが長いためQRを作成できません。URLをコピーしてください。' },
 en: { title:'Staff Materials Portal',readOnly:'Staff · Read only',GENERAL:'General staff',TECHNICAL:'Technical staff',common:'Common materials',performer:'Performer materials',preview:'Preview',download:'Download',latest:'Current version',empty:'No materials yet',invalid:'This link is invalid or expired. Please contact ARA-TECH.',error:'Unable to load. Please refresh.',refresh:'Refresh',date:'Event date',venue:'Venue',time:'Show time',timezone:'Event time zone',updated:'Updated',close:'Close',language:'Language',manage:'Staff sharing',create:'Create',rotate:'Reissue',revoke:'Revoke',expiry:'Expires',saveExpiry:'Save expiry',active:'Active',inactive:'Not issued, revoked or expired',copy:'Copy URL',copied:'Copied',settings:'Save event times',end:'Event end (optional)',hint:'End +24 hours. Without an end time: 23:59 the following event day.',qrHold:'Redisplaying the same QR later is not available. Save the issued URL/QR securely. Reissuing revokes the old link.',confirmRotate:'Revoke this grade’s old URL and sessions and issue a new link?',confirmRevoke:'Revoke this grade’s link?',content:'Common materials are originals the organizer or ARA-TECH considers suitable for staff sharing.',original:'Original documents retain their content and language.',localTime:'Entered times use the event time zone.',qrLong:'URL is too long for a QR. Please copy the URL.' },
 es: { title:'Portal de documentos del personal',readOnly:'Personal · Solo lectura',GENERAL:'Personal general',TECHNICAL:'Personal técnico',common:'Documentos comunes',performer:'Documentos de artistas',preview:'Vista previa',download:'Descargar',latest:'Versión actual',empty:'Todavía no hay documentos',invalid:'El enlace no es válido o ha caducado. Contacte con ARA-TECH.',error:'No se pudo cargar. Actualice la página.',refresh:'Actualizar',date:'Fecha del evento',venue:'Lugar',time:'Hora de actuación',timezone:'Zona horaria del evento',updated:'Actualizado',close:'Cerrar',language:'Idioma',manage:'Compartir con el personal',create:'Crear',rotate:'Reemitir',revoke:'Revocar',expiry:'Caducidad',saveExpiry:'Guardar caducidad',active:'Activo',inactive:'No emitido, revocado o caducado',copy:'Copiar URL',copied:'Copiado',settings:'Guardar horarios',end:'Fin del evento (opcional)',hint:'Fin +24 horas. Sin hora de fin: 23:59 del día siguiente al evento.',qrHold:'No se puede volver a mostrar el mismo QR más tarde. Guarde la URL/QR de forma segura. La reemisión revoca el enlace anterior.',confirmRotate:'¿Revocar la URL y las sesiones de este grado y crear un enlace nuevo?',confirmRevoke:'¿Revocar el enlace de este grado?',content:'Los documentos comunes son originales que el organizador o ARA-TECH considera aptos para compartir con el personal.',original:'Los documentos originales conservan su contenido e idioma.',localTime:'Los horarios introducidos usan la zona horaria del evento.',qrLong:'La URL es demasiado larga para un QR. Copie la URL.' }
};
const STORAGE='ara.portal.locale';
export function chooseLocale(saved,languages=[]) {
 if (Object.hasOwn(dictionaries,saved)) return saved;
 for(const language of languages) { const base=String(language).toLowerCase().split('-')[0]; if(Object.hasOwn(dictionaries,base)) return base; }
 return 'en';
}
export function createLocaleController(onChange=()=>{}) {
 let saved;try{saved=localStorage.getItem(STORAGE);}catch{}
 let locale=chooseLocale(saved,navigator.languages || [navigator.language]);
 const controller={get locale(){return locale;},t:key=>dictionaries[locale][key] || dictionaries.en[key] || key,set(value){if(!Object.hasOwn(dictionaries,value)) return;locale=value;try{localStorage.setItem(STORAGE,value);}catch{}document.documentElement.lang=value;onChange(controller);}};
 document.documentElement.lang=locale;return controller;
}
export function languagePicker(controller) {
 const select=document.createElement('select');select.setAttribute('aria-label',controller.t('language'));
 for(const [value,label] of [['ja','日本語'],['en','English'],['es','Español']]){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}
 select.value=controller.locale;select.addEventListener('change',()=>controller.set(select.value));return select;
}
export function eventDate(value,locale) {if(!/^\d{4}-\d{2}-\d{2}$/u.test(value || ''))return value || '—';return new Intl.DateTimeFormat(locale,{timeZone:'UTC',dateStyle:'long'}).format(new Date(`${value}T00:00:00Z`));}
export function eventInstant(value,locale,timezone) {return value?new Intl.DateTimeFormat(locale,{timeZone:timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'—';}
export function instantToLocal(value,timezone) {
 if(!value)return '';const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function localToInstant(value,timezone) {
 if(!value)return null;if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value))throw new Error('invalid_time');
 const wanted=Date.parse(`${value}:00Z`);let result=wanted;
 for(let n=0;n<3;n++) result+=wanted-Date.parse(`${instantToLocal(new Date(result).toISOString(),timezone)}:00Z`);
 const iso=new Date(result).toISOString();if(instantToLocal(iso,timezone)!==value)throw new Error('invalid_time');return iso;
}
