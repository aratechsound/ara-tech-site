import {createGallery} from './gallery.mjs';
import {carouselPosition,carouselMove,visibleAttachments} from './carousel-model.mjs';

// One gallery receives the original mail attachment array directly. No category
// lookup, sorting, deduplication, grouping or alternate original retrieval occurs.
export function createMailAttachmentCarousel({isCurrent,requestBlob}){
  const gallery=createGallery({isCurrent,requestBlob});let cleanup=()=>{};
  function mount(track,items){
    cleanup();gallery.mount(track,items,{compact:true});
    const host=track.closest('.mail-attachments'),left=host.querySelector('[data-carousel-left]'),right=host.querySelector('[data-carousel-right]');
    track.tabIndex=0;track.setAttribute('role','region');track.setAttribute('aria-label','添付 '+items.length+'件。右端から元の添付順に表示');
    const dimensions=()=>({scrollLeft:track.scrollLeft,scrollWidth:track.scrollWidth,clientWidth:track.clientWidth});
    const update=()=>{const p=carouselPosition(dimensions());track.dataset.overflow=String(p.maximum>1);if(left)left.disabled=!p.canLeft;if(right)right.disabled=!p.canRight;};
    const move=direction=>{track.scrollLeft=carouselMove(dimensions(),direction,track.clientWidth+7);update();};
    if(left)left.onclick=()=>move('left');if(right)right.onclick=()=>move('right');
    const key=e=>{
      if(e.target!==track)return;
      const step=(track.clientWidth+7)/Math.max(1,visibleAttachments(items.length));
      if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();track.scrollLeft=carouselMove(dimensions(),e.key==='ArrowLeft'?'left':'right',step);}
      else if(e.key==='Home'){e.preventDefault();track.scrollLeft=0;}
      else if(e.key==='End'){e.preventDefault();track.scrollLeft=-carouselPosition(dimensions()).maximum;}
      else return;
      update();
    };
    // Leave both axes of wheel/trackpad events native. In particular vertical
    // wheel events must continue scrolling the vertical mail list.
    track.addEventListener('scroll',update,{passive:true});track.addEventListener('keydown',key);
    const observer=new ResizeObserver(update);observer.observe(track);track.scrollLeft=0;update();
    cleanup=()=>{observer.disconnect();track.removeEventListener('scroll',update);track.removeEventListener('keydown',key);if(left)left.onclick=null;if(right)right.onclick=null;};
  }
  return {mount,dispose(){cleanup();gallery.dispose();}};
}
