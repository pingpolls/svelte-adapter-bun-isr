<script lang="ts">
    import TodoList from "$lib/todo-list.svelte";

    let { data } = $props();
</script>

<h1>Slug Test</h1>

<p>
    Todo Id: {data.todo.id}
</p>
<p>
    Todo Text: {data.todo.text}
</p>
<p>
    Todo Slug: {data.todo.slug}
</p>
