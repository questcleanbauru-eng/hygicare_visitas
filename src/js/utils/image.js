// Comprime uma imagem escolhida (câmera/galeria) no navegador ANTES de
// enviar pro servidor: redimensiona pro lado maior <= maxDim e reencoda em
// JPEG. Uma foto de celular de 3-5 MB vira ~150-300 KB — cabe folgado no
// limite de corpo de request da Vercel (~4,5 MB) e sobe rápido no 4G.
export function compressImageFile(file, { maxDim = 1280, quality = 0.7 } = {}) {
    return new Promise((resolve, reject) => {
        if (!file || !/^image\//.test(file.type)) {
            reject(new Error('Arquivo não é uma imagem.'));
            return;
        }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            let { width, height } = img;
            if (Math.max(width, height) > maxDim) {
                const s = maxDim / Math.max(width, height);
                width = Math.round(width * s);
                height = Math.round(height * s);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);
            try {
                resolve(canvas.toDataURL('image/jpeg', quality));
            } catch (e) {
                reject(new Error('Não foi possível processar a imagem.'));
            }
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagem inválida.')); };
        img.src = url;
    });
}
