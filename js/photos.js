export function initPhotoUpload({ fileInputEl, onImageDataURL }) {
    if (!fileInputEl) return;
    fileInputEl.addEventListener('change', (e) => {
        const files = e.target.files;
        if (!files || !files.length) return;
        Array.from(files).forEach(f => {
            const reader = new FileReader();
            reader.onload = (ev) => {
                onImageDataURL(ev.target.result);
            };
            reader.readAsDataURL(f);
        });
    });
}