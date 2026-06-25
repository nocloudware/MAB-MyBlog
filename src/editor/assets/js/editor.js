import { renderPreview } from './markdown.js';
import { processImageToWebP } from './image.js';

export class Editor {
    constructor() {
        this.isPreviewMode = false;
        this.imageData = null;
        this.init();
    }

    init() {
        const titleInput = document.getElementById('title');
        const contentInput = document.getElementById('content');
        const imageInput = document.getElementById('image');
        const previewBtn = document.getElementById('preview-btn');
        const previewPane = document.getElementById('preview-pane');
        const imagePreview = document.getElementById('image-preview');

        titleInput?.addEventListener('input', this.updateSlug.bind(this));
        previewBtn?.addEventListener('click', this.togglePreview.bind(this));
        contentInput?.addEventListener('input', this.updatePreview.bind(this));
        imageInput?.addEventListener('change', this.handleImageUpload.bind(this));

        this.updatePreview();
    }

    updateSlug() {
        const title = document.getElementById('title').value;
        const slug = slugify(title);
        const slugInput = document.getElementById('slug');
        if (slugInput) {
            slugInput.value = slug;
        }
    }

    togglePreview() {
        this.isPreviewMode = !this.isPreviewMode;
        const previewBtn = document.getElementById('preview-btn');
        const previewPane = document.getElementById('preview-pane');
        const contentInput = document.getElementById('content');

        if (this.isPreviewMode) {
            previewBtn.textContent = 'Back to Edit';
            previewBtn.classList.add('active');
            previewPane.classList.add('visible');
            contentInput.style.display = 'none';
        } else {
            previewBtn.textContent = 'Preview';
            previewBtn.classList.remove('active');
            previewPane.classList.remove('visible');
            contentInput.style.display = 'block';
        }
    }

    updatePreview() {
        const content = document.getElementById('content').value;
        const previewPane = document.getElementById('preview-pane');
        if (previewPane) {
            previewPane.innerHTML = renderPreview(content);
        }
    }

    async handleImageUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const webpBase64 = await processImageToWebP(file);
            this.imageData = webpBase64.split(',')[1];
            const imagePreview = document.getElementById('image-preview');
            if (imagePreview) {
                imagePreview.src = webpBase64;
                imagePreview.classList.add('visible');
            }
        } catch (error) {
            console.error('Error processing image:', error);
            alert('Error processing image. Please try again.');
        }
    }
}

function slugify(text) {
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w\-]+/g, '')
        .replace(/\-\-+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
}

document.addEventListener('DOMContentLoaded', () => {
    window.editor = new Editor();
});