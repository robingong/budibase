<script>
  import { builderStore } from "stores"
  import IndicatorSet from "./IndicatorSet.svelte"
</script>

<IndicatorSet
  componentId={$builderStore.selectedComponentId}
  color="var(--spectrum-global-color-static-blue-600)"
  zIndex="910"
  transition
/>
