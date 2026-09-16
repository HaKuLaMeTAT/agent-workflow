// An editable picker: its arrow always opens the full catalog, while typing
// filters suggestions without restricting custom values.
export function combobox(input,toggle,list) {
  const container=input.parentElement;let options=[],visible=[],active=-1,showAll=true;
  input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');
  input.setAttribute('aria-controls',list.id);input.setAttribute('aria-expanded','false');
  toggle.setAttribute('aria-controls',list.id);toggle.setAttribute('aria-expanded','false');
  function close(){list.hidden=true;input.setAttribute('aria-expanded','false');toggle.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;}
  function highlight(index){
    active=index;
    [...list.children].forEach((node,i)=>node.setAttribute('aria-selected',String(i===index)));
    if(index<0){input.removeAttribute('aria-activedescendant');return;}
    const node=list.children[index];input.setAttribute('aria-activedescendant',node.id);node.scrollIntoView({block:'nearest'});
  }
  function choose(value){input.value=value;close();input.focus();input.dispatchEvent(new Event('input',{bubbles:true}));close();}
  function render(){
    const query=input.value.toLowerCase();visible=options.filter(o=>showAll||o.value.toLowerCase().includes(query));
    list.replaceChildren(...visible.map((option,index)=>{
      const node=document.createElement('div');node.id=`${list.id}-${index}`;node.setAttribute('role','option');node.className='combo-option';
      const value=document.createElement('span');value.textContent=option.value||'不指定（默认）';node.append(value);
      if(option.label){const label=document.createElement('small');label.textContent=option.label;node.append(label);}
      node.addEventListener('pointerdown',e=>e.preventDefault());node.addEventListener('click',()=>choose(option.value));return node;
    }));
    if(!visible.length){const empty=document.createElement('div');empty.className='combo-empty';empty.textContent='没有匹配项，可直接输入自定义值。';list.append(empty);}
    highlight(-1);
  }
  function open(all){showAll=all;render();list.hidden=false;input.setAttribute('aria-expanded','true');toggle.setAttribute('aria-expanded','true');}
  toggle.addEventListener('click',()=>{const wasOpen=!list.hidden;input.focus();if(wasOpen)close();else{open(true);highlight(visible.findIndex(o=>o.value===input.value));}});
  input.addEventListener('input',()=>open(false));
  input.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    if(['ArrowDown','ArrowUp'].includes(event.key)) {
      event.preventDefault();if(list.hidden){open(true);active=visible.findIndex(o=>o.value===input.value);}
      if(visible.length)highlight(active<0?(event.key==='ArrowDown'?0:visible.length-1):(active+(event.key==='ArrowDown'?1:-1)+visible.length)%visible.length);
    }else if(event.key==='Enter'&&!list.hidden){event.preventDefault();if(active>=0)choose(visible[active].value);else close();}
    else if(event.key==='Escape'&&!list.hidden){event.preventDefault();close();}
    else if(event.key==='Tab')close();
  });
  container.addEventListener('focusout',event=>{if(!container.contains(event.relatedTarget))close();});
  document.addEventListener('pointerdown',event=>{if(!container.contains(event.target))close();});
  return {setOptions(values){options=[...new Map(values.map(o=>[o.value,o])).values()];toggle.disabled=options.length===0;close();}};
}
