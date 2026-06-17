from django.contrib.auth import authenticate
from django.contrib.auth.models import User
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.tokens import RefreshToken

from .serializers import LoginSerializer, UserSerializer, CreateUserSerializer, UpdateUserSerializer


def _tokens_for_user(user):
    refresh = RefreshToken.for_user(user)
    refresh['role'] = 'superadmin' if user.is_staff else 'user'
    return {
        'access': str(refresh.access_token),
        'refresh': str(refresh),
        'role': 'superadmin' if user.is_staff else 'user',
        'username': user.username,
        'name': user.get_full_name() or user.username,
    }


class LoginView(APIView):
    authentication_classes = []
    permission_classes = []

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = authenticate(
            username=serializer.validated_data['username'],
            password=serializer.validated_data['password'],
        )
        if not user:
            return Response({'error': 'Invalid username or password.'}, status=status.HTTP_401_UNAUTHORIZED)
        if not user.is_active:
            return Response({'error': 'This account has been disabled.'}, status=status.HTTP_401_UNAUTHORIZED)
        return Response(_tokens_for_user(user))


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(UserSerializer(request.user).data)


class UserListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not request.user.is_staff:
            return Response({'error': 'Forbidden.'}, status=status.HTTP_403_FORBIDDEN)
        users = User.objects.filter(is_superuser=False).order_by('-date_joined')
        return Response(UserSerializer(users, many=True).data)

    def post(self, request):
        if not request.user.is_staff:
            return Response({'error': 'Forbidden.'}, status=status.HTTP_403_FORBIDDEN)
        serializer = CreateUserSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)


class UserDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def _get_user(self, pk):
        try:
            return User.objects.get(pk=pk, is_superuser=False)
        except User.DoesNotExist:
            return None

    def patch(self, request, pk):
        if not request.user.is_staff:
            return Response({'error': 'Forbidden.'}, status=status.HTTP_403_FORBIDDEN)
        user = self._get_user(pk)
        if not user:
            return Response({'error': 'User not found.'}, status=status.HTTP_404_NOT_FOUND)
        serializer = UpdateUserSerializer(user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(UserSerializer(user).data)

    def delete(self, request, pk):
        if not request.user.is_staff:
            return Response({'error': 'Forbidden.'}, status=status.HTTP_403_FORBIDDEN)
        user = self._get_user(pk)
        if not user:
            return Response({'error': 'User not found.'}, status=status.HTTP_404_NOT_FOUND)
        user.is_active = False
        user.save()
        return Response(status=status.HTTP_204_NO_CONTENT)
