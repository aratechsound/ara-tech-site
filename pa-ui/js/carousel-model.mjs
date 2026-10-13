export const visibleAttachments=count=>Math.min(4,Math.max(0,count));
export function carouselPosition({scrollLeft=0,scrollWidth=0,clientWidth=0}){
  const maximum=Math.max(0,scrollWidth-clientWidth),offset=Math.min(maximum,Math.max(0,-scrollLeft));
  return {maximum,offset,canLeft:offset<maximum-1,canRight:offset>1};
}
export function carouselMove(dimensions,direction,step){
  const {maximum,offset}=carouselPosition(dimensions);
  const next=Math.min(maximum,Math.max(0,offset+(direction==='left'?step:-step)));
  return next===0?0:-next;
}
