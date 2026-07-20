<script lang="ts">
    import TodoList from "$lib/todo-list.svelte";

    let { data } = $props();
</script>

<TodoList id="page-todo" todos={data.todos} />
<TodoList id="layout-todo" todos={data.layoutTodo} />
