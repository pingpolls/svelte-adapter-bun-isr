<script lang="ts">
    import { page } from "$app/state";
</script>

<svelte:head>
    <title>SABI | {page.error?.message}</title>
</svelte:head>

<h1 class="text-primary text-6xl font-bold drop-shadow-sm">
    {page.status}
</h1>

<p class="text-3xl text-gray-700 dark:text-gray-100">
    {page.error?.message}
</p>

<button type="button" onclick={() => history.back()}> Go Back </button>

<p>Yabeda Bedu</p>
