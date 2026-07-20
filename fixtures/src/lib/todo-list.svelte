<script lang="ts">
    import type { Todo } from "$src/types";

    type Props = {
        id: string;
        todos: Todo[];
    };

    let { todos, id }: Props = $props();
</script>

<section {id}>
    <ul>
        {#each todos as todo (todo.id)}
            <li>{todo.text}</li>
        {/each}
    </ul>
</section>
