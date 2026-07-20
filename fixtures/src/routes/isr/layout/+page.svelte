<script lang="ts">
    import TodoList from "$lib/todo-list.svelte";

    let { data } = $props();
</script>

<TodoList todos={data.layoutTodo} />
