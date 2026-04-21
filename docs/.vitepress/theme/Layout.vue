<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import InstallCommand from './components/InstallCommand.vue';

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #home-hero-info-after>
      <InstallCommand />
    </template>
  </Layout>
</template>
