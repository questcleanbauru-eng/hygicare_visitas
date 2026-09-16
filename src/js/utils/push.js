import { state } from '../app.js';
import { callAPI } from '../api.js';

// Chave pública VAPID — não é segredo (só a privada, guardada só no
// backend, é sensível), por isso pode ficar direto aqui em vez de buscar
// do servidor a cada vez.
const VAPID_PUBLIC_KEY = 'BJaNrDCP2UrxsNZAIjqPU31_Aq8afV8Wca0lNXwNS_b25bxOASyYPlfxPIvXOySsYTWniwUGv9z4ZOqZEWLUOMs';

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export function isPushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isAppInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

// No iPhone, Web Push só funciona com o app instalado na Tela de Início —
// aberto pelo Safari normal, nem 'PushManager' existe. É o único caso em
// que "pedir pra ativar notificação" não adianta nada sem primeiro instalar.
export function isIOS() {
    return /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// 'unsupported' | 'denied' | 'subscribed' | 'not-subscribed'
export async function getPushState() {
    if (!isPushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (!reg) return 'unsupported';
    const sub = await reg.pushManager.getSubscription().catch(() => null);
    return sub ? 'subscribed' : 'not-subscribed';
}

export async function enablePush() {
    if (!isPushSupported()) throw new Error('Este navegador não suporta notificações.');
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Permissão de notificação não concedida.');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
        sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
    }
    await callAPI('subscribePush', { subscription: sub.toJSON(), userAgent: navigator.userAgent, user: state.currentUser });
    return sub;
}

export async function disablePush() {
    if (!isPushSupported()) return;
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription().catch(() => null);
    if (!sub) return;
    await callAPI('unsubscribePush', { endpoint: sub.endpoint, user: state.currentUser }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
}
