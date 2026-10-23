<script lang="ts">
import TodoList from "#lib/todo-list.svelte";

let { data } = $props();
</script>

<p data-testid="rendered-at">{data.renderedAt}</p>
<TodoList todos={data.todos} />
