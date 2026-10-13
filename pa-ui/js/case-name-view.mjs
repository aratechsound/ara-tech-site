// Measure only on list/layout changes; movement is a CSS animation.
export function createCaseNameView(){
  let observer=null;
  function mount(root){
    observer?.disconnect();
    const measure=name=>{
      const track=name.firstElementChild,original=track.firstElementChild,copy=track.lastElementChild;
      const overflow=original.getBoundingClientRect().width>name.clientWidth+1;
      name.classList.toggle('scrolling',overflow);copy.hidden=!overflow;
      const distance=original.getBoundingClientRect().width+32;
      name.style.setProperty('--name-distance',distance+'px');name.style.setProperty('--name-duration',Math.max(12,distance/24)+'s');
    };
    observer=new ResizeObserver(entries=>entries.forEach(e=>measure(e.target)));
    root.querySelectorAll('.casename').forEach(name=>{measure(name);observer.observe(name);});
    document.fonts?.ready.then(()=>{if(root.isConnected)root.querySelectorAll('.casename').forEach(measure);});
  }
  return {mount};
}
