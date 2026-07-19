<script lang="ts">
	import TodoList from '$lib/TodoList.svelte';
	let { data = { todos: [] } }: { data: { todos: { id: number; text: string }[] } } = $props()
</script>

<section>
	<h1>/with-isr (Revalidates every 5s)</h1>
	<TodoList todos={data.todos} />
</section>
