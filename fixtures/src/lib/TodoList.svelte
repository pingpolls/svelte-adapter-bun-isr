<script lang="ts">
	let { todos = [] }: { todos: { id: number; text: string }[] } = $props()
</script>

<div style="border: 1px solid #ccc; padding: 1rem; margin-bottom: 1rem; border-radius: 4px;">
	<h2 style="margin-top: 0;">Todo List</h2>
	<ul>
		{#each todos as todo (todo.id)}
			<li>{todo.text}</li>
		{/each}
	</ul>
</div>
