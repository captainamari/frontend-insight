import "element-plus/es/components/alert/style/css";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/dialog/style/css";
import "element-plus/es/components/drawer/style/css";
import "element-plus/es/components/form/style/css";
import "element-plus/es/components/input/style/css";
import "element-plus/es/components/input-number/style/css";
import "element-plus/es/components/pagination/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/skeleton/style/css";
import "element-plus/es/components/table/style/css";
import "element-plus/es/components/tag/style/css";
import "element-plus/es/components/tooltip/style/css";
import "./styles.css";
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElDrawer,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElOption,
  ElPagination,
  ElSelect,
  ElSkeleton,
  ElTable,
  ElTableColumn,
  ElTag,
  ElTooltip,
} from "element-plus";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";

const app = createApp(App);
for (const component of [
  ElAlert,
  ElButton,
  ElDialog,
  ElDrawer,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElOption,
  ElPagination,
  ElSelect,
  ElSkeleton,
  ElTable,
  ElTableColumn,
  ElTag,
  ElTooltip,
]) {
  app.component(component.name!, component);
}
app.use(router).mount("#app");
