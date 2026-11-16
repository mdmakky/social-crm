/* Shared demo behaviour: icons, the three auth screens (sign in, create account, reset password), validation, loading, error, success. Real copy comes from apps/web/app/(auth). */
const IC={msg:'<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',cam:'<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',phone:'<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',eyeoff:'<path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 8 10 8a13.2 13.2 0 0 1-1.67 2.68M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.39-1.61M2 2l20 20"/>',arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',check:'<path d="M20 6 9 17l-5-5"/>',alert:'<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',inbox:'<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',kanban:'<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18M15 3v18"/>',user:'<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',lock:'<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',send:'<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',mail:'<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'};
window.I=(n,c='')=>`<svg class="i ${c}" aria-hidden="true" viewBox="0 0 24 24">${IC[n]}</svg>`;
const LOGO=`<span class="logo"><i>${I('msg')}</i>Social CRM</span>`;
let mode='login',state='normal';
const $=id=>document.getElementById(id);
function formHTML(){
 const reg=mode==='register',forgot=mode==='forgot';
 if(forgot&&state==='sent')return `<div class="form"><div><h1>Check your email</h1><p class="lead">If an account exists for <b>you@shop.com</b>, we sent a link to choose a new password. It works for one hour.</p></div><div class="alert ok show">${I('check','sm')}<span>Link sent.</span></div><p class="lead" style="font-size:13.5px;margin:0">Nothing arrived? Check spam, or try again with the address you signed up with.</p><p class="alt"><button type="button" data-go="login">Back to sign in</button></p></div>`;
 const title=forgot?'Reset your password':reg?'Create your account':'Welcome back';
 const lead=forgot?'Enter your account email and we’ll send you a link to choose a new password.':reg?'Start with a workspace for your business.':'Sign in to continue to your workspace.';
 const cta=forgot?'Send reset link':reg?'Create account':'Sign in';
 const bad=state==='error',v=state==='invalid',busy=state==='loading';
 return `<form class="form" id="f" novalidate>
 <div><h1>${title}</h1><p class="lead">${lead}</p></div>
 <div class="alert ok ${mode==='login'&&state==='reset'?'show':''}">${I('check','sm')}<span>Password updated. Sign in with your new password.</span></div>
 <div class="alert bad ${bad?'show':''}" role="alert">${I('alert','sm')}<span>${reg?'We couldn’t create your account. Check your details and try again.':'Email or password is incorrect.'}</span></div>
 ${reg?`<div class="field ${v?'err':''}"><label for="n">Full name</label><input class="input" id="n" autocomplete="name" placeholder="Maya Okafor"><span class="msg">Enter your name.</span></div>`:''}
 <div class="field ${v?'err':''}"><label for="e">Email</label><input class="input" id="e" type="email" autocomplete="email" placeholder="you@shop.com" value="${v?'maya@':''}"><span class="msg">Enter a valid email address.</span></div>
 ${forgot?'':`<div class="field ${v?'err':''}"><span class="lab"><label for="p">Password</label>${reg?'':'<a href="#" data-go="forgot">Forgot password?</a>'}</span><div class="pw"><input class="input" id="p" type="password" autocomplete="${reg?'new-password':'current-password'}" placeholder="${reg?'At least 10 characters':'Your password'}"><button type="button" id="eye" aria-label="Show password">${I('eye')}</button></div><span class="msg">${reg?'Use at least 10 characters.':'Enter your password.'}</span></div>`}
 <button class="btn" type="submit" aria-busy="${busy}"><span class="sp"></span><span>${busy?(forgot?'Sending…':reg?'Creating…':'Signing in…'):cta}</span>${busy?'':I(forgot?'mail':'arrow')}</button>
 <p class="alt">${forgot?'<button type="button" data-go="login">Back to sign in</button>':reg?'Already have an account? <button type="button" data-go="login">Sign in</button>':'New here? <button type="button" data-go="register">Create an account</button>'}</p></form>`}
function paint(){$('form').innerHTML=formHTML();document.querySelectorAll('[data-go]').forEach(b=>b.onclick=e=>{e.preventDefault();mode=b.dataset.go;state='normal';paint();syncSw()});
 const eye=$('eye');if(eye)eye.onclick=()=>{const p=$('p'),s=p.type==='password';p.type=s?'text':'password';eye.innerHTML=I(s?'eyeoff':'eye');eye.setAttribute('aria-label',s?'Hide password':'Show password')};
 const f=$('f');if(f)f.onsubmit=e=>{e.preventDefault();state='loading';paint();setTimeout(()=>{state=mode==='forgot'?'sent':'error';paint();syncSw()},1100)};
 document.dispatchEvent(new CustomEvent('painted',{detail:{mode,state}}))}
function syncSw(){document.querySelectorAll('.sw [data-m]').forEach(b=>b.classList.toggle('on',b.dataset.m===mode));document.querySelectorAll('.sw [data-s]').forEach(b=>b.classList.toggle('on',b.dataset.s===state))}
document.addEventListener('DOMContentLoaded',()=>{
 const sw=document.createElement('div');sw.className='sw';sw.setAttribute('aria-label','Demo controls');
 sw.innerHTML='<b>Screen</b><button data-m="login">Sign in</button><button data-m="register">Create account</button><button data-m="forgot">Reset</button><span class="gap"></span><b>State</b><button data-s="normal">Default</button><button data-s="invalid">Invalid</button><button data-s="error">Error</button><button data-s="loading">Loading</button><span class="gap"></span><a href="index.html">All options</a>';
 document.body.appendChild(sw);
 sw.onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.m){mode=b.dataset.m;state='normal'}if(b.dataset.s)state=b.dataset.s;paint();syncSw()};
 paint();syncSw()});
