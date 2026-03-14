import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		host: process.env.BIND_HOST || '0.0.0.0',
		port: parseInt(process.env.PORT || '3000', 10)
	}
});
