<script lang="ts">
    import type { Todo } from "$src/types";

    type Props = {
        todos: Todo[];
    };

    let { todos }: Props = $props();
</script>

<section>
    <ul>
        {#each todos as todo (todo.id)}
            <li>{todo.text}</li>
        {/each}
    </ul>
</section>
