import {createLocaleController,languagePicker,dictionaries} from './portal-i18n.mjs';
import {organizerMessageRows} from './portal-organizer-messages.mjs';
export function organizerI18n(enabled,onChange){
 const originalKeys=new Map(organizerMessageRows.map(row=>[row[1],row[0]]));
 const bound=new Map();let locale;
 const message=(source,params={})=>{const key=Object.hasOwn(dictionaries.ja,source)?source:originalKeys.get(source);if(!key)return source;return{key,params,toString:()=>enabled&&locale?locale.t(key,params):dictionaries.ja[key].replace(/\{(\w+)\}/gu,(_,name)=>String(params[name]??`{${name}}`))};};
 const ui=(node,value)=>{if(value?.key)bound.set(node,value);else bound.delete(node);node.textContent=String(value??'');return node;};
 const apply=()=>{for(const node of document.querySelectorAll('[data-i18n]'))ui(node,message(node.dataset.i18n));for(const node of document.querySelectorAll('[data-i18n-aria]'))node.setAttribute('aria-label',String(message(node.dataset.i18nAria)));for(const [node,value]of bound){if(node.isConnected)node.textContent=String(value);else bound.delete(node);}for(const picker of document.querySelectorAll('.organizer-locale-picker')){picker.value=locale.locale;picker.setAttribute('aria-label',locale.t('language'));}document.title=String(message('orgTitle'))+' | ARA-TECH';};
 if(enabled){locale=createLocaleController(()=>{apply();onChange?.(locale);});for(const target of ['.header-inner','#manage-dialog .manage-dialog__head','#preview-dialog .preview-dialog__head']){const picker=languagePicker(locale);picker.className='organizer-locale-picker';if(target==='.header-inner')picker.id='organizer-language';document.querySelector(target).append(picker);}apply();}
 return{message,ui,get locale(){return enabled?locale.locale:'ja';},apply};
}
