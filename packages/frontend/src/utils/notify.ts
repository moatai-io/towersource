import { toastSuccess, toastError } from './toast';

export function notifyTaskComplete(title: string, status: 'done' | 'failed') {
  if (status === 'done') {
    toastSuccess(`Task completed: ${title}`);
  } else {
    toastError(`Task failed: ${title}`);
  }
  // Browser notification when tab is not focused
  showBrowserNotification(
    status === 'done' ? 'Task Completed' : 'Task Failed',
    title,
  );
}

/** Show a browser notification when the tab is hidden */
export function showBrowserNotification(title: string, body: string) {
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification(title, {
      body,
      icon: '/favicon.ico',
    });
  }
}

export function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}
