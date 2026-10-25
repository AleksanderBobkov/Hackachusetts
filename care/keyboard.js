// Cage on Raspberry Pi OS Lite has no desktop keyboard. Offer one for touch text entry.
export function initTouchKeyboard({enabled=navigator.maxTouchPoints>0}={}){
  if(!enabled)return;
  let field=null, shifted=true, layout='letters';
  const keyboard=document.createElement('section');keyboard.className='touch-keyboard';
  keyboard.setAttribute('aria-label','Touch keyboard');
  const rows={letters:['qwertyuiop','asdfghjkl','zxcvbnm'],numbers:['1234567890','@#$%&*()-','.,?!:;\'"/'],accents:['áàâäãåæçéè','êëíìîïñóòô','öõœúùûüłąęśżźćń']};
  const key=(value,label=value)=>{const button=document.createElement('button');button.type='button';button.className='touch-key';button.textContent=label;button.dataset.key=value;return button;};
  function draw(){
    keyboard.replaceChildren();
    for(const text of rows[layout]){const row=document.createElement('div');row.className='touch-key-row';for(const char of text)row.append(key(char,shifted?char.toLocaleUpperCase():char));keyboard.append(row);}
    const row=document.createElement('div');row.className='touch-key-row';
    row.append(key('shift',shifted?'a ⇧':'A ⇧'),key('layout',layout==='numbers'?'ABC':'123'),key('accents',layout==='accents'?'ABC':'áéñ'),key('space','Space'),key('backspace','⌫'),key('done','Done'));
    keyboard.append(row);
  }
  function hide(){keyboard.remove();field=null;document.body.classList.remove('touch-typing');}
  keyboard.addEventListener('pointerdown',event=>event.preventDefault()); // retain caret/focus
  keyboard.addEventListener('click',event=>{
    const value=event.target.closest('[data-key]')?.dataset.key;
    if(!value||!field?.isConnected){hide();return;}
    if(value==='done'){const input=field;hide();input.blur();return;}
    if(value==='shift'){shifted=!shifted;draw();return;}
    if(value==='layout'){layout=layout==='numbers'?'letters':'numbers';draw();return;}
    if(value==='accents'){layout=layout==='accents'?'letters':'accents';draw();return;}
    let start=field.selectionStart??field.value.length,end=field.selectionEnd??start;
    let text=value==='space'?' ':value==='backspace'?'':shifted?value.toLocaleUpperCase():value;
    if(value==='backspace'&&start===end&&start>0)start-=Array.from(field.value.slice(0,start)).at(-1).length;
    if(field.maxLength>=0&&field.value.length-(end-start)+text.length>field.maxLength)return;
    field.setRangeText(text,start,end,'end');field.dispatchEvent(new Event('input',{bubbles:true}));
    if(shifted&&value.length===1){shifted=false;draw();}
  });
  document.addEventListener('focusin',event=>{
    const input=event.target;
    if(input.matches('textarea,input:not([type]),input[type=text],input[type=search]')&&!input.readOnly&&!input.disabled){
      field=input;shifted=input.value.length===0;layout='letters';draw();
      const dialog=input.closest('dialog');
      (dialog?.querySelector('form')||dialog||document.body).append(keyboard);
      document.body.classList.toggle('touch-typing',!dialog);
      requestAnimationFrame(()=>input.scrollIntoView({block:'nearest'}));
    }
    // Keep the keyboard in place while a submit button receives focus. Removing it on
    // pointer-down recenters a modal before pointer-up, which can swallow the touch click.
  });
  new MutationObserver(()=>{if(field&&!field.isConnected)hide();}).observe(document.body,{childList:true,subtree:true});
  document.addEventListener('close',event=>{if(event.target.tagName==='DIALOG')hide();},true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape')hide();});
}
