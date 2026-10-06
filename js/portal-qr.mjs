// Fixed QR Model 2, version 6, level L, byte mode, mask 0.
// 134 UTF-8 bytes cover the canonical staff URL; no remote QR service.
const gf=(a,b)=>{let r=0;for(let i=7;i>=0;i--){r=(r<<1)^((r>>>7)*0x11d);r^=((b>>>i)&1)*a;}return r;};
function ecc(data){const divisor=Array(18).fill(0);divisor[17]=1;let root=1;for(let i=0;i<18;i++){for(let j=0;j<18;j++)divisor[j]=gf(divisor[j],root)^(j<17?divisor[j+1]:0);root=gf(root,2);}const rem=Array(18).fill(0);for(const b of data){const factor=b^rem.shift();rem.push(0);for(let i=0;i<18;i++)rem[i]^=gf(divisor[i],factor);}return rem;}
export function qrMatrix(text){
 const bytes=new TextEncoder().encode(text);if(bytes.length>134)throw new Error('qr_too_long');const bits=[];const push=(v,n)=>{for(let i=n-1;i>=0;i--)bits.push((v>>>i)&1);};push(4,4);push(bytes.length,8);for(const b of bytes)push(b,8);push(0,Math.min(4,1088-bits.length));while(bits.length%8)bits.push(0);
 const data=[];for(let i=0;i<bits.length;i+=8)data.push(bits.slice(i,i+8).reduce((v,b)=>(v<<1)|b,0));while(data.length<136)data.push(data.length%2===(bits.length/8)%2?0xec:0x11);
 const blocks=[data.slice(0,68),data.slice(68)];const parity=blocks.map(ecc);const words=[];for(let i=0;i<68;i++)for(const b of blocks)words.push(b[i]);for(let i=0;i<18;i++)for(const b of parity)words.push(b[i]);
 const size=41,m=Array.from({length:size},()=>Array(size).fill(false)),reserved=Array.from({length:size},()=>Array(size).fill(false));
 const set=(x,y,v)=>{if(x>=0&&x<size&&y>=0&&y<size){m[y][x]=!!v;reserved[y][x]=true;}};
 for(const [cx,cy] of [[3,3],[37,3],[3,37]])for(let y=-4;y<=4;y++)for(let x=-4;x<=4;x++){const d=Math.max(Math.abs(x),Math.abs(y));set(cx+x,cy+y,d!==2&&d!==4);}
 for(let i=0;i<size;i++){if(!reserved[6][i])set(i,6,i%2===0);if(!reserved[i][6])set(6,i,i%2===0);}
 for(let y=-2;y<=2;y++)for(let x=-2;x<=2;x++)set(34+x,34+y,Math.max(Math.abs(x),Math.abs(y))!==1);
 let rem=8;for(let i=0;i<10;i++)rem=(rem<<1)^((rem>>>9)*0x537);const format=((8<<10)|rem)^0x5412,bit=i=>(format>>>i)&1;
 for(let i=0;i<6;i++)set(8,i,bit(i));set(8,7,bit(6));set(8,8,bit(7));set(7,8,bit(8));for(let i=9;i<15;i++)set(14-i,8,bit(i));for(let i=0;i<8;i++)set(size-1-i,8,bit(i));for(let i=8;i<15;i++)set(8,size-15+i,bit(i));set(8,size-8,true);
 let at=0;for(let right=size-1;right>=1;right-=2){if(right===6)right=5;for(let v=0;v<size;v++){const y=((right+1)&2)===0?size-1-v:v;for(let j=0;j<2;j++){const x=right-j;if(reserved[y][x])continue;const value=at<words.length*8?((words[at>>>3]>>>(7-(at&7)))&1):0;m[y][x]=!!(value^((x+y)%2===0?1:0));at++;}}}
 return m;
}
export function qrSvg(url){const m=qrMatrix(url);const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 49 49');svg.setAttribute('width','245');svg.setAttribute('height','245');svg.setAttribute('role','img');svg.setAttribute('aria-label','QR');const bg=document.createElementNS(svg.namespaceURI,'rect');bg.setAttribute('width','49');bg.setAttribute('height','49');bg.setAttribute('fill','white');svg.append(bg);const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',m.flatMap((row,y)=>row.flatMap((dark,x)=>dark?[`M${x+4},${y+4}h1v1h-1z`]:[])).join(''));path.setAttribute('fill','black');svg.append(path);return svg;}
