export class Publisher {
    constructor() {
        this.apiUrl = '/api';
        this.token = null;
        this.initializeAuth();
        this.setupEventListeners();
    }

    async initializeAuth() {
        this.token = localStorage.getItem('adminToken');
    }

    async login(password) {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });

        if (response.ok) {
            const data = await response.json();
            this.token = data.token;
            localStorage.setItem('adminToken', this.token);
            return true;
        }
        return false;
    }

    async logout() {
        localStorage.removeItem('adminToken');
        this.token = null;
    }

    async createPost(postData) {
        const response = await fetch('/api/posts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`
            },
            body: JSON.stringify(postData)
        });
        return response.json();
    }

    async updatePost(slug, postData) {
        const response = await fetch(`/api/posts/${slug}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`
            },
            body: JSON.stringify(postData)
        });
        return response.json();
    }

    async deletePost(slug) {
        const response = await fetch(`/api/posts/${slug}?`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${this.token}`
            }
        });
        return response.json();
    }

    setupEventListeners() {
        document.addEventListener('submit', async e => {
            e.preventDefault();
            if (!this.token) {
                alert('Please login first');
                return;
            }

            const formData = new FormData(e.target);
            const postData = {
                title: formData.get('title'),
                content: formData.get('content'),
                image: formData.get('image') || null,
                author: formData.get('author') || 'Author',
                status: formData.get('status') || 'published',
                default_hashtags: formData.get('default_hashtags') || ''
            };

            const createBtn = e.target.querySelector('button[type="submit"]');
            createBtn.disabled = true;
            createBtn.textContent = 'Publishing...';

            try {
                const result = await this.createPost(postData);
                alert('Post created successfully!');
                location.href = `/post/${result.slug}`;
            } catch (error) {
                console.error('Error creating post:', error);
                alert(`Error creating post: ${error.message}`);
            } finally {
                createBtn.disabled = false;
                createBtn.textContent = 'Create Post';
            }
        });
    }
}

window.Publisher = new Publisher();
