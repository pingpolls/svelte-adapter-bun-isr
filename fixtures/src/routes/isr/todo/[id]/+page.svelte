<script lang="ts">
    import TodoList from "$lib/todo-list.svelte";

    let { data } = $props();
</script>

Todo Id: {data.todo.id}
Todo Text: {data.todo.text}
